<#
Maximise the DSH window from outside the application.

Why this is not an Electron call: the plugin Host runs as a plain Node child
process (`desktopNodeEnvironment` sets `ELECTRON_RUN_AS_NODE=1`), so it has no
`BrowserWindow` — the windows belong to the Electron main process. The desktop
shell exposes no IPC that changes window geometry either. A Win32 call from the
Host's own PowerShell is the only route left, and it is the same mechanism
`tools/pick-media-file.ps1` already uses to reach a native dialog.

Prints exactly one word on stdout, which is the whole result contract:
  none       no window found yet — the caller may retry on a later page load
  already    the window was maximised already; nothing was changed
  maximized  this call maximised it
  refused    the call was made but the window did not end up maximised

argv: -ProcessName <name>  the executable name owning the window, without .exe
#>
param(
  [Parameter(Mandatory = $true)][string]$ProcessName
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace DshSplash -Name Window -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
'@

# The Host process runs the same executable but owns no window, so filtering on
# a non-zero MainWindowHandle is what separates the product window from us. A
# title is required too: handle-less helper windows would otherwise qualify.
$target = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
  Select-Object -First 1

if ($null -eq $target) {
  Write-Output 'none'
  exit 0
}

$handle = $target.MainWindowHandle
if ([DshSplash.Window]::IsZoomed($handle)) {
  Write-Output 'already'
  exit 0
}

$null = [DshSplash.Window]::ShowWindow($handle, 3) # SW_MAXIMIZE
Start-Sleep -Milliseconds 150
if ([DshSplash.Window]::IsZoomed($handle)) {
  Write-Output 'maximized'
} else {
  Write-Output 'refused'
}
