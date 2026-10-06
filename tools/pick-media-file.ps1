# Native picker for the dsh-splash-animation settings page.
#
# Spawned by the plugin's Host half, which cannot open a native dialog itself:
# the Host is a plain Node child process (ELECTRON_RUN_AS_NODE=1), so it has no
# Electron dialog either. Windows ships WinForms with the .NET runtime PowerShell
# already loads, so this needs no dependency and no install step.
#
# Contract with the caller:
#   - STA is required: the common dialogs are COM objects and throw on an MTA
#     thread, which is why the caller must pass -STA (Windows PowerShell 5.1
#     defaults to STA, but `pwsh` 7 defaults to MTA).
#   - The selected path is written to -OutFile as UTF-8, NOT to stdout. A console
#     writes text through the system ANSI code page (GBK on a Chinese Windows), so
#     a path with non-ASCII characters comes back as mojibake when the caller
#     decodes it as UTF-8 -- which is exactly how the first version turned a
#     Chinese file name into `????.mp4`. A file carries its own encoding and
#     cannot be corrupted by a code page.
#   - THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 decodes a BOM-less
#     script as ANSI, so any non-ASCII character in it -- even inside a string --
#     is read as the wrong bytes and the whole script fails to parse. That is why
#     the dialog title arrives as -Title from the caller (Node, which is UTF-8
#     clean) instead of being written here. If you need a localized string, pass
#     it in; do not paste it in.
#   - Nothing is written when the user cancels, so "no file" means cancel.
#   - Diagnostics go to stderr, never into the result.
#   - Exit code 0 covers both "picked" and "cancelled"; a non-zero code means the
#     dialog itself failed, which the caller reports as an environment problem
#     rather than as a user cancellation.
#
# Two dialogs, two mechanisms, on purpose:
#   - `file`   -> WinForms OpenFileDialog. .NET's AutoUpgradeEnabled defaults to
#                 true on Vista+, so this already IS the modern common item dialog.
#   - `folder` -> IFileOpenDialog with FOS_PICKFOLDERS, called through COM. This is
#                 the modern folder picker (breadcrumb bar, navigation pane).
#                 System.Windows.Forms.FolderBrowserDialog was the first attempt
#                 and had to go: it is the Windows XP-era tree dialog.
#                 Shell.Application.BrowseForFolder is the same old dialog and is
#                 not an alternative.

param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$InitialDirectory = '',
  [string]$InitialFile = '',
  # 'file' or 'folder'.
  [string]$Mode = 'file',
  # Dialog title, supplied by the caller so this file can stay pure ASCII.
  [string]$Title = 'Select folder',
  # Exercise the COM plumbing and exit WITHOUT showing anything. Used by the test
  # suite: a dialog cannot be clicked from a script, but a wrong vtable offset or
  # a failed COM activation shows up here.
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# The modern folder picker.
#
# This is the minimum of IFileDialog / IShellItem needed to set FOS_PICKFOLDERS,
# seed the starting folder and read the result. The method order in these
# interfaces is the COM vtable order and must not be rearranged -- one missing
# method silently shifts every later call onto the wrong slot. Written in C# 5
# because Windows PowerShell 5.1 compiles with the old compiler: no expression
# bodies, no string interpolation, no `nameof`.
# ---------------------------------------------------------------------------
$modernFolderSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace DshSplash
{
    public static class ModernFolderPicker
    {
        [ComImport, ClassInterface(ClassInterfaceType.None), Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
        }

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        private const uint FOS_PICKFOLDERS = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        /// Configure a dialog the way Pick() does, and report what came back.
        /// Touches activation, SetOptions, GetOptions and SetTitle -- the calls
        /// whose vtable slots would be wrong if the interface were misdeclared.
        public static string Probe()
        {
            IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
            uint before;
            dialog.GetOptions(out before);
            dialog.SetOptions(before | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            dialog.SetTitle("probe");
            uint after;
            dialog.GetOptions(out after);
            bool picked = (after & FOS_PICKFOLDERS) != 0;
            bool seeded = (after & FOS_FORCEFILESYSTEM) != 0;
            return (picked && seeded) ? "ok" : "options-not-set";
        }

        /// Show the picker. Returns the folder path, or "" when cancelled.
        public static string Pick(string title, string initial)
        {
            IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            if (title != null && title.Length > 0) dialog.SetTitle(title);
            if (initial != null && initial.Length > 0 && Directory.Exists(initial))
            {
                IShellItem folder;
                Guid iid = IID_IShellItem;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                dialog.SetFolder(folder);
            }
            if (dialog.Show(IntPtr.Zero) != 0) return string.Empty;
            IShellItem result;
            dialog.GetResult(out result);
            string path;
            result.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path == null ? string.Empty : path;
        }
    }
}
'@

function Write-Choice([string]$Path) {
  if ($Path -eq '') { return }
  # No BOM: the caller reads this as plain UTF-8 and would otherwise get a
  # U+FEFF glued to the front of a Windows path.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $Path, $utf8NoBom)
}

try {
  if ($Mode -eq 'folder') {
    if (-not ('DshSplash.ModernFolderPicker' -as [type])) {
      Add-Type -TypeDefinition $modernFolderSource -Language CSharp
    }
    if ($Probe) {
      [Console]::Out.Write([DshSplash.ModernFolderPicker]::Probe())
      exit 0
    }
    Write-Choice ([DshSplash.ModernFolderPicker]::Pick($Title, $InitialDirectory))
    exit 0
  }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select a video or animated image for the DSH splash'
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.Multiselect = $false
  $dialog.RestoreDirectory = $true

  # Filter order matters: the first entry is what the dialog opens on. The
  # "All supported" entry repeats the same set so a user who does not care about
  # the distinction still sees every acceptable file.
  $video = 'Video (*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts)|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts'
  $image = 'Animated / still image (*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico)|*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'
  $all = 'All supported media|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts;*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'
  $dialog.Filter = "$all|$video|$image|All files (*.*)|*.*"

  if ($InitialDirectory -ne '' -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.InitialDirectory = $InitialDirectory
  }
  if ($InitialFile -ne '') {
    $dialog.FileName = $InitialFile
  }

  # A dialog owned by a hidden form is centred on the screen and reliably comes
  # to the front; without an owner it can appear behind the browser window.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.WindowState = 'Minimized'
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0

  $result = $dialog.ShowDialog($owner)
  $owner.Dispose()

  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Choice $dialog.FileName
  }
  $dialog.Dispose()
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
