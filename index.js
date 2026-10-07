/**
 * dsh-splash-animation — Host half.
 *
 * Responsibilities the browser half cannot have:
 *   1. storing the chosen video path (a browser cannot read a local file path,
 *      so the choice has to live on the Host and be made through a native
 *      dialog the Host opens),
 *   2. resolving that path to a real file and serving its bytes over the DSH web
 *      transport with HTTP Range, so a video streams progressively instead of
 *      being buffered whole,
 *   3. publishing the effective settings so the browser half needs no build step
 *      and no second copy of the configuration,
 *   4. opening the native file picker on request from the settings page.
 *
 * Two configuration sources, later wins:
 *   - the row `config` in the profile's `cordis.patch.yml` (advanced settings),
 *   - `$DSH_HOME/dsh-splash-animation/config.json`, written by the settings page.
 *
 * Zero runtime dependencies, deliberately: a plugin installed with `link:`
 * resolves its imports from its own real directory, so a dependency that only
 * ships inside the DSH installation fails with ERR_MODULE_NOT_FOUND and takes
 * the whole profile down with it.
 *
 * @module dsh-splash-animation
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of this package's directory; the picker script resolves from here. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** Route namespace. Absolute, so the same string works over HTTP and over the Electron IPC bridge. */
const ROUTE_BASE = '/dsh-splash-animation'
const CONFIG_ROUTE = `${ROUTE_BASE}/config.json`
const MEDIA_ROUTE = `${ROUTE_BASE}/asset`
const SAVE_ROUTE = `${ROUTE_BASE}/config`
const PICK_ROUTE = `${ROUTE_BASE}/pick`
/**
 * The browser half reports the splash's own lifetime here.
 *
 * The Host cannot see when the overlay leaves — that happens in the page — so
 * the fullscreen feature is driven by the half that actually knows: asked for
 * when the overlay mounts, released when it goes. Registering the request from
 * the browser also means a client half that never runs can never leave the
 * window fullscreen.
 */
const SPLASH_ROUTE = `${ROUTE_BASE}/splash`

/** Boolean settings the settings page owns and the state file stores verbatim. */
const SWITCH_KEYS = ['tailDissolve', 'startMaximized', 'random', 'muted']

/** Phases the browser half reports. Only `startup` is acted on, once per process. */
const SPLASH_PHASES = ['startup']

/** Directory inside the DSH home that holds this plugin's own state. */
const STATE_DIRNAME = 'dsh-splash-animation'

/**
 * The bundled default video, shipped inside the package.
 *
 * Used while `src` has never been chosen, so a fresh install plays something
 * without any configuration. It is resolved from the package directory rather
 * than the DSH home, which makes it work the same for a `link:` install, an npm
 * install and a tarball install — "relative path" support is really "rebase onto
 * wherever the package was installed", and that is what `import.meta.url` gives.
 */
const BUNDLED_MEDIA = join(PACKAGE_DIR, 'assets', 'default.mp4')

/**
 * The clips this package ships and draws from when nothing else is configured.
 *
 * Two roles, and the difference between them is the whole feature:
 *
 *   - `primary` — the opener. The FIRST splash of a fresh install is always this
 *     one, so a first impression is deliberate instead of a coin toss.
 *   - `hidden` — an easter egg. It is in the draw from the very beginning, so it
 *     can come up on any later start, but it is NOT listed in the settings page
 *     until it has actually played once. Finding it in the list is the reward for
 *     having seen it on screen.
 *
 * A clip that is missing from the package is skipped, not fatal: the pool is a
 * convenience and the install must still boot.
 */
const BUNDLED_CLIPS = [
  { name: 'PRTS启动-10秒.mp4', primary: true },
  { name: '普鲸声音重叠.mp4', hidden: true },
]

/** Where the shipped clips live: the same folder the README points users at. */
const BUNDLED_CLIP_DIR = join(PACKAGE_DIR, 'media')

/**
 * How many times the opener plays before a hidden clip is guaranteed.
 *
 * Three starts of the opener, then the fourth is the easter egg. The point is the
 * guarantee, not the scheduling: the egg may still be drawn earlier by `random`,
 * and this is simply the start after which it can no longer be missed.
 */
const OPENER_RUN = 3

/**
 * The media that should play, honouring the three-state `src` rule.
 *
 * Order of precedence:
 *   1. `src === ''` — the user cleared it. Never play; no default may override an
 *      explicit decision.
 *   2. `src` is a path — validate and use it (a broken path reports a problem and
 *      does not silently fall back to the bundled video, because substituting a
 *      different video than the one asked for is worse than playing nothing).
 *   3. `src === undefined` — never chosen, so the bundled default applies if the
 *      package ships one; otherwise do not engage.
 * @param src - the effective `src` value.
 * @param dshHome - absolute DSH home directory.
 * @returns a descriptor with `configured`, plus `source` describing which rule won.
 */
export function resolveEffectiveMedia(src, dshHome) {
  if (typeof src === 'string') {
    const trimmed = src.trim()
    if (trimmed === '') return { configured: false, source: 'cleared' }
    return { ...resolveMedia(trimmed, dshHome), source: 'chosen' }
  }
  if (!existsSync(BUNDLED_MEDIA)) return { configured: false, source: 'unset' }
  const bundled = resolveMedia(BUNDLED_MEDIA, dshHome)
  // A packaged file that will not resolve is a packaging fault, not a user error;
  // report it as "not engaging" so DSH still boots cleanly.
  if (bundled.configured !== true) return { configured: false, source: 'unset' }
  return { ...bundled, source: 'bundled' }
}

/**
 * Every file this plugin may play, in list order.
 *
 * ONE source of truth for the two places that must agree: the configuration
 * route picks one of these and tells the page its URL, and the media route
 * decides what it is allowed to serve. They were computed separately once, the
 * folder arrived, and the splash spent a whole start 404-ing on its own video.
 *
 * Ticking is the ONLY thing that makes a file eligible. An empty tick list is a
 * decision — play nothing — not a missing one, so a configured folder never
 * quietly turns into "everything in it", and never falls back to the bundled
 * video behind the user's back.
 *
 * @param settings - the effective configuration.
 * @param dshHome - absolute DSH home directory.
 * @returns one `{ root, name, bytes }` per candidate, or an empty list.
 */
function eligibleEntries(settings, dshHome) {
  const folder = typeof settings?.folder === 'string' ? settings.folder.trim() : ''
  if (folder !== '') {
    const root = toAbsolutePath(folder, dshHome)
    const ticked = Array.isArray(settings?.selected) ? settings.selected : []
    return listLibrary(folder, dshHome)
      .filter((entry) => ticked.includes(entry.name))
      .map((entry) => ({ root, name: entry.name, bytes: entry.bytes }))
  }
  // No folder: the single path from before the folder existed, if the user
  // actually set one. The BUNDLED video is deliberately not an entry here — it is
  // the fallback `resolveEffectiveMedia` applies when nothing is configured, and
  // listing it would relabel it as a deliberate choice: `source` came back
  // `chosen` instead of `bundled`, and the settings page lost the path it is
  // meant to show for a never-configured install.
  const raw = typeof settings?.src === 'string' ? settings.src.trim() : ''
  if (raw === '') return []
  const single = resolveMedia(raw, dshHome)
  if (single.configured === true && single.problem === undefined) {
    return [{ root: dirname(single.path), name: single.name, bytes: single.bytes }]
  }
  return []
}

/**
 * Choose which reference to resolve: a ticked file in the folder, else `src`.
 *
 * A configured folder that yields no candidate returns the empty string, which
 * resolves to "not configured" and leaves DSH to start normally — the user
 * ticked nothing, and substituting the bundled video would override a decision
 * they just made. Only a profile with no folder at all falls back to `src`.
 *
 * @param settings - the effective configuration.
 * @param dshHome - absolute DSH home directory.
 * @param pick - random source in [0, 1); injectable for the test suite.
 * @returns the reference to resolve.
 */
/**
 * The shipped clips that are actually present, in pool order.
 *
 * A clip the package does not contain is skipped rather than fatal: the pool is a
 * convenience, and an install missing one file must still boot.
 *
 * @param dshHome - absolute DSH home directory.
 * @returns one entry per shipped clip that resolves, tagged with its role.
 */
export function bundledClipEntries(dshHome) {
  const entries = []
  for (const clip of BUNDLED_CLIPS) {
    const media = resolveMedia(join(BUNDLED_CLIP_DIR, clip.name), dshHome)
    if (media.configured !== true || media.problem !== undefined) continue
    entries.push({
      root: BUNDLED_CLIP_DIR,
      name: clip.name,
      bytes: media.bytes,
      primary: clip.primary === true,
      hidden: clip.hidden === true,
    })
  }
  return entries
}

/**
 * The shipped clips as the settings page should list them.
 *
 * The opener is always listed. A hidden clip is listed only once it has actually
 * played — that IS the reveal, and it is the whole point of the feature: you find
 * it in the list because you already saw it on screen.
 *
 * @param dshHome - absolute DSH home directory.
 * @returns entries shaped like `listLibrary`'s, plus `shipped` and `primary`.
 */
export function shippedLibrary(dshHome) {
  const revealed = poolState(dshHome).revealed
  return bundledClipEntries(dshHome)
    .filter((entry) => entry.hidden !== true || revealed.includes(entry.name))
    .map((entry) => {
      const extension = extensionOf(entry.name)
      return {
        name: entry.name,
        extension,
        kind: IMAGE_KIND.has(extension) ? 'image' : 'video',
        bytes: entry.bytes,
        shipped: true,
        primary: entry.primary === true,
      }
    })
}

/**
 * Compare two paths the way the platform does.
 *
 * Windows paths are case-insensitive, so `C:\Media\x.mp4` and `c:\media\x.mp4`
 * are the same file.
 *
 * @param a - one path.
 * @param b - the other path.
 * @returns true when they point at the same file.
 */
function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  if (left === right) return true
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase()
}

/**
 * What previous starts left behind about the shipped pool.
 *
 * Counters written by a version whose counting was unsound are DISCARDED rather
 * than trusted. Before 0.6.0 there was no `openerPlays`, and the play count
 * matched on file NAME alone — so a user's own copy of a shipped clip (which the
 * README actively tells people to make) counted as a shipped play and could reveal
 * the easter egg without the egg ever having been drawn.
 *
 * A state file that has plays but no `openerPlays` can only have come from those
 * versions, so it is self-healing: the counters reset, the first start is the
 * opener again, and the egg goes back to being genuinely hidden. Losing a count is
 * cheap; a permanently mis-revealed egg is not.
 *
 * @param dshHome - absolute DSH home directory.
 * @returns `{ plays, openerPlays, revealed }`.
 */
export function poolState(dshHome) {
  const state = readState(dshHome)
  const untrustworthy = Number(state.plays) > 0 && state.openerPlays === undefined
  if (untrustworthy) return { plays: 0, openerPlays: 0, revealed: [] }
  return {
    plays: Number(state.plays) || 0,
    openerPlays: Number(state.openerPlays) || 0,
    revealed: Array.isArray(state.unlocked) ? state.unlocked.filter((name) => typeof name === 'string') : [],
  }
}

/**
 * Is this resolved file the package's OWN copy of a shipped clip?
 *
 * The file name alone is not enough, and assuming it was is a real mistake: the
 * README tells users to copy these clips into their own media folder, so a file
 * with the same name is usually the USER's copy. Treating that copy as shipped
 * spends the first-start slot (the opener stops being guaranteed), reveals the
 * easter egg for a file that never came from the package, and labels a file the
 * user chose as something the package provided.
 *
 * A user who points their folder straight at the package's `media/` still counts:
 * the same file is being served, whichever route the path arrived by.
 *
 * @param media - a resolved descriptor.
 * @param dshHome - absolute DSH home directory.
 * @returns true when the served path is the package's own file.
 */
export function isShippedClip(media, dshHome) {
  const name = media?.name
  if (typeof name !== 'string' || typeof media?.path !== 'string') return false
  const clip = BUNDLED_CLIPS.find((entry) => entry.name === name)
  if (clip === undefined) return false
  return samePath(media.path, join(BUNDLED_CLIP_DIR, clip.name))
}

/**
 * Relabel a resolved descriptor when the winner is a shipped clip.
 *
 * Picking one out of the pool produces a path, and a path always resolves as
 * `chosen` — but a shipped clip is not a user choice, and saying it is would make
 * the page claim the user had configured something they never touched. It also
 * feeds `chosen`, which is what tells the page whether an explicit decision
 * exists yet.
 *
 * @param media - a descriptor from `resolveEffectiveMedia`.
 * @param dshHome - absolute DSH home directory.
 * @returns the descriptor, relabelled when it is a shipped clip.
 */
export function labelShipped(media, dshHome) {
  if (media?.source !== 'chosen') return media
  return isShippedClip(media, dshHome) ? { ...media, source: 'shipped' } : media
}

/**
 * Pick one entry from a list: the first when not random, else a bounded draw.
 *
 * @param entries - the candidates, in order.
 * @param random - the `random` setting.
 * @param pick - random source, injectable for tests.
 * @returns the chosen entry.
 */
function drawFrom(entries, random, pick) {
  if (random !== true) return entries[0]
  // `pick` is a test seam; a caller-supplied one must not be able to take the
  // page load down with it, so a throw falls back to the first entry.
  let raw = 0
  try {
    raw = typeof pick === 'function' ? Number(pick()) : 0
  } catch {
    raw = 0
  }
  const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0
  return entries[Math.floor(bounded * entries.length)]
}

/**
 * Draw from the shipped pool.
 *
 * Three rules, in order:
 *
 *   1. The first splash of an install is always the opener, so the very first
 *      impression is deliberate rather than a coin toss.
 *   2. Once the opener has had its run (see `OPENER_RUN`), an unseen hidden clip
 *      is forced. Without this the easter egg is only *probable*: with `random`
 *      off it would never arrive at all, and with it on a coin can keep landing
 *      on the opener forever. "You might see it" is not an easter egg — "you will
 *      see it on the fourth start" is.
 *   3. Otherwise the pool is drawn normally, **including any hidden clip** — which
 *      is what lets the egg be found earlier than the guarantee.
 *
 * @param entries - the shipped clips that resolve.
 * @param random - the `random` setting.
 * @param pick - random source, injectable for tests.
 * @param state - `{ plays, openerPlays, revealed }` from previous serves.
 * @returns the chosen entry, or `undefined` when the pool is empty.
 */
function drawFromPool(entries, random, pick, state) {
  if (entries.length === 0) return undefined
  const opener = entries.find((entry) => entry.primary === true) ?? entries[0]
  const plays = Number(state?.plays) || 0
  if (plays <= 0) return opener
  const revealed = Array.isArray(state?.revealed) ? state.revealed : []
  const unseen = entries.filter((entry) => entry.hidden === true && !revealed.includes(entry.name))
  if (unseen.length > 0 && (Number(state?.openerPlays) || 0) >= OPENER_RUN) return unseen[0]
  return drawFrom(entries, random, pick)
}

/**
 * Which media reference should play, before it is resolved.
 *
 * Order of precedence:
 *   1. A configured folder draws from the files ticked inside it.
 *   2. Otherwise a single legacy `src` path, if one was ever chosen.
 *   3. Otherwise — nothing configured at all — the shipped pool draws, and its
 *      first play is always the opener.
 *
 * A folder that is set but has nothing ticked stays "play nothing": an empty tick
 * list is a decision, not an invitation to substitute something else.
 *
 * @param settings - the effective configuration.
 * @param dshHome - absolute DSH home directory.
 * @param pick - random source, injectable for tests.
 * @param pool - `{ entries, plays }` describing the shipped clips.
 * @returns the reference to resolve.
 */
export function pickEffectiveSource(settings, dshHome, pick = Math.random, pool = {}) {
  const folder = typeof settings?.folder === 'string' ? settings.folder.trim() : ''
  const entries = eligibleEntries(settings, dshHome)
  if (entries.length > 0) {
    const chosen = drawFrom(entries, settings?.random, pick)
    return join(chosen.root, chosen.name)
  }
  // `typeof src !== 'string'` is the "never chosen" state. An empty string is a
  // deliberate clear and must keep meaning "play nothing"; `undefined` is a fresh
  // install, which is what the shipped pool exists for.
  if (folder === '' && typeof settings?.src !== 'string') {
    // The pool draws from ALL shipped clips; the tick list deliberately does NOT
    // narrow it. It used to, and that produced a closed loop: a fresh install lists
    // only the opener (the egg is hidden until it plays), the page says "ticking
    // none plays nothing", the natural move is to tick the one row you can see —
    // and the pool then holds only the opener. The fourth start never becomes the
    // egg, and the egg is never listed, because it never played. Nothing said so.
    //
    // The shipped clips are not a folder and are not governed by its rule, which is
    // why the settings page now shows them in their own group, with no tick boxes.
    const chosen = drawFromPool(
      Array.isArray(pool?.entries) ? pool.entries : [],
      settings?.random,
      pick,
      pool,
    )
    if (chosen !== undefined) return join(chosen.root, chosen.name)
  }
  return folder === '' ? settings?.src : ''
}

/**
 * Resolve one requested file name against the eligible set.
 *
 * This is what lets the media route serve whatever the configuration route
 * announced, without either of them guessing at the other's rule.
 *
 * @param settings - the effective configuration.
 * @param dshHome - absolute DSH home directory.
 * @param requested - the decoded name from the request path.
 * @returns the media descriptor, or `undefined` when it must not be served.
 */
export function resolveRequestedMedia(settings, dshHome, requested) {
  const hit = eligibleEntries(settings, dshHome).find((entry) => entry.name === requested)
  if (hit !== undefined) {
    const media = resolveEffectiveMedia(join(hit.root, hit.name), dshHome)
    if (media.configured !== true || media.problem !== undefined) return undefined
    return media
  }
  // Nothing is configured at all, so the BUNDLED video is what the configuration
  // route told the page to play — and it has to be servable too. The bundled
  // video is deliberately not an eligible ENTRY (labelling it one made the page
  // report "chosen" instead of "bundled"), but that distinction is about the
  // label, not about who may be served. Missing this made a fresh install hand
  // the page a URL the media route answered 404 for, i.e. no splash at all.
  const announced = resolveEffectiveMedia(settings?.src, dshHome)
  if (announced.source === 'bundled' && announced.name === requested) return announced
  // A shipped clip. The configuration route draws one whenever the user has
  // configured nothing, so the media route has to be able to serve it.
  const shipped = bundledClipEntries(dshHome).find((entry) => entry.name === requested)
  if (shipped !== undefined) {
    const media = resolveEffectiveMedia(join(shipped.root, shipped.name), dshHome)
    if (media.configured === true && media.problem === undefined) return media
  }
  return undefined
}

/**
 * Accepted media formats: extension (no dot, lower case) → MIME type.
 *
 * `.mov` and `.mkv` are containers, not codecs, so whether a given file plays
 * depends on the codec inside it; the browser half probes `canPlayType` at
 * runtime rather than guessing here. `SUPPORTED-FORMATS.md` records the matrix.
 */
const FORMATS = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogm: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  gif: 'image/gif',
  apng: 'image/apng',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

/** Extensions that are animation-by-themselves and therefore render as `<img>` rather than `<video>`. */
const IMAGE_KIND = new Set(['gif', 'apng', 'webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'bmp', 'ico'])

/** Containers worth answering a `Range` request against. */
const SEEKABLE = new Set(['video/mp4', 'video/webm', 'video/x-matroska', 'video/ogg', 'video/quicktime', 'video/mp2t'])

/** Largest media file this plugin will serve; guards against a mis-typed path. */
const MAX_MEDIA_BYTES = 4096 * 1024 * 1024

/** Upper bound on a stored path, so a malformed request cannot fill the state file. */
const MAX_SRC_LENGTH = 4096

/** How long the native picker may stay open before the Host gives up on it. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Documented defaults.
 *
 * Plain object rather than a schema: this package must resolve with zero
 * dependencies (see the module doc). Every field is coerced by
 * {@link normalizeConfig}, so a bad value degrades one setting instead of
 * refusing to boot.
 */
export const DEFAULTS = {
  src: undefined,
  duration: 0,
  skip: 'button',
  skipAfterMs: 1200,
  muted: true,
  volume: 0.6,
  /**
   * How the artwork fills the window.
   *
   * Defaults to `cover`: the splash is a full-screen surface, so scaling the media
   * up until it covers the frame — cropping whatever overflows, never stretching —
   * is what fills the screen. `contain` would letterbox, which on a 16:9 video in
   * a wider window leaves black bands top and bottom.
   */
  fit: 'cover',
  background: '#000000',
  fadeInMs: 320,
  /**
   * How long the overlay takes to dissolve once the video has finished playing.
   *
   * The video plays in full; only then does the overlay fade, revealing the
   * interface underneath. `holdAfterEndMs` is the gap between the two.
   */
  fadeOutMs: 300,
  playbackRate: 1,
  waitForAppMs: 2500,
  holdAfterEndMs: 0,
  maxReplays: 0,
  /**
   * Whether the dissolve starts before the clip ends (tail cross-dissolve).
   *
   * Off — the default, and the behaviour every earlier version had — plays the
   * clip in full on top of the interface and only then dissolves, so the last
   * frame is held for `fadeOutMs` after the clip is over. On, the dissolve
   * begins `fadeOutMs` before the clip ends, so the clip is still visibly
   * playing while the interface comes through underneath and the hand-off
   * completes exactly on the clip's last frame. `holdAfterEndMs` has no effect
   * in this mode. Ignored while `maxReplays > 0`, because dissolving before the
   * first pass would cut the repeats short; it applies to single-pass clips.
   */
  tailDissolve: false,
  /**
   * Whether the DSH window is maximized when the application starts.
   *
   * Applied at most ONCE per host process, from the browser half's start-up
   * report — which is what makes "start-up" mean the application rather than the
   * page. A plain reload reports again and is deliberately ignored, so a window
   * the user has just restored is not snapped back to maximized under them.
   *
   * How it is done, and why it looks like this: the Host is a plain Node child
   * process (`ELECTRON_RUN_AS_NODE=1`), so it has no `BrowserWindow` — the
   * windows belong to the Electron main process — and the desktop shell exposes
   * no IPC that changes window geometry. The only route left is a Win32 call
   * from the Host's own PowerShell, which is the same mechanism the file picker
   * already uses. Consequences: Windows only, and it drives the window from
   * outside the application. Off by default.
   */
  startMaximized: false,
  /**
   * Whether one of the ticked files is played at random instead of the first.
   *
   * Rolled on the Host when the page asks for its configuration, so every
   * application start rolls again. The browser half receives one already
   * resolved file and knows nothing about the folder or the selection.
   */
  random: false,
  /**
   * The folder the settings page lists and the user ticks files in.
   *
   * Absent means the plugin falls back to `src` (a path from an earlier
   * version) and then to the bundled video. A folder whose listing is empty
   * behaves the same way, so a wrong folder cannot black out the splash.
   */
  folder: undefined,
  /**
   * File NAMES, not paths, ticked inside `folder`.
   *
   * Names rather than paths so moving or renaming the folder does not silently
   * invalidate every entry. An empty selection means "everything in the folder",
   * which is what keeps choosing a folder without ticking anything from playing
   * nothing at all.
   */
  selected: [],
}

/** `skip` values the player implements. */
const SKIP_MODES = new Set(['button', 'click', 'auto', 'never'])
/** `fit` values, mapped onto CSS `object-fit`. */
const FIT_MODES = new Set(['contain', 'cover', 'fill'])

/**
 * Accept `value` as a finite number inside `[min, max]`, else `fallback`.
 * @param value - the configured value.
 * @param fallback - the default.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the accepted number.
 */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/**
 * Accept a value from a closed set, else `fallback`.
 * @param value - the configured value.
 * @param allowed - the accepted values.
 * @param fallback - the default.
 * @returns the accepted value.
 */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/**
 * Coerce a raw configuration into the effective settings.
 * @param raw - merged configuration object.
 * @returns the effective configuration with every field present and valid.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const background = typeof input.background === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.background)
    ? input.background
    : DEFAULTS.background
  // No migration here. Deriving a folder from a legacy `src` is a DISPLAY concern
  // (the upgrade should show the user's own video, already ticked, instead of an
  // empty page that looks like data loss) and it is applied when the settings page
  // is told what to show — see `legacyFolderView`.
  //
  // Doing it here instead meant `normalizeConfig` rewrote every legacy install into
  // folder + tick, so a legacy path that no longer exists stopped being reported as
  // "missing-file" and came back as "cleared" — the media route announced nothing,
  // the page showed nothing, and there was no explanation anywhere.
  const declaredFolder = typeof input.folder === 'string' ? input.folder.trim() : ''
  return {
    // `undefined` is preserved, and it means "never chosen" — which is what lets a
    // bundled default apply. An empty string means "clear", i.e. never play.
    src: typeof input.src === 'string' ? input.src.slice(0, MAX_SRC_LENGTH) : undefined,
    duration: clampNumber(input.duration, DEFAULTS.duration, 0, 600000),
    skip: oneOf(input.skip, SKIP_MODES, DEFAULTS.skip),
    skipAfterMs: clampNumber(input.skipAfterMs, DEFAULTS.skipAfterMs, 0, 60000),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULTS.muted,
    volume: clampNumber(input.volume, DEFAULTS.volume, 0, 1),
    fit: oneOf(input.fit, FIT_MODES, DEFAULTS.fit),
    background,
    fadeInMs: clampNumber(input.fadeInMs, DEFAULTS.fadeInMs, 0, 10000),
    fadeOutMs: clampNumber(input.fadeOutMs, DEFAULTS.fadeOutMs, 0, 10000),
    playbackRate: clampNumber(input.playbackRate, DEFAULTS.playbackRate, 0.1, 4),
    waitForAppMs: clampNumber(input.waitForAppMs, DEFAULTS.waitForAppMs, 0, 60000),
    holdAfterEndMs: clampNumber(input.holdAfterEndMs, DEFAULTS.holdAfterEndMs, 0, 60000),
    maxReplays: Math.round(clampNumber(input.maxReplays, DEFAULTS.maxReplays, 0, 100)),
    tailDissolve: typeof input.tailDissolve === 'boolean' ? input.tailDissolve : DEFAULTS.tailDissolve,
    startMaximized: typeof input.startMaximized === 'boolean' ? input.startMaximized : DEFAULTS.startMaximized,
    random: typeof input.random === 'boolean' ? input.random : DEFAULTS.random,
    folder: declaredFolder === '' ? undefined : declaredFolder,
    // The tick list is stored, never derived. `legacyFolderView` derives what to
    // DISPLAY for an install that predates folders.
    selected: normalizeSelected(input.selected),
  }
}

/** How many files one folder may offer. Bounds the settings payload. */
const MAX_LIBRARY = 500

/**
 * Derive the folder a legacy single path sits in.
 *
 * Two details that matter more than they look:
 *   - the trailing separator is dropped, so the settings field shows
 *     `…\media` rather than `…\media\`;
 *   - a drive root keeps its separator — stripping it would leave `C:`, which is
 *     not an absolute path and would resolve against the DSH home instead.
 * @param legacy - the stored `src`.
 * @returns the folder, or `undefined` when there is nothing usable.
 */
function folderFromLegacy(legacy) {
  const cut = legacy.slice(0, Math.max(legacy.lastIndexOf('/'), legacy.lastIndexOf('\\')) + 1)
  if (cut === '') return undefined
  const bare = cut.replace(/[\\/]+$/, '')
  if (bare === '' || bare.endsWith(':')) return cut
  return bare
}

/**
 * What the settings page should be shown for the folder and the tick list.
 *
 * An install from before folders existed stores one `src` path and no folder.
 * Showing an empty folder field would look like the configuration was lost, so
 * the page is handed the derived folder with that one file already ticked.
 *
 * This is deliberately a VIEW layered on top of the effective settings, not a
 * rewrite of them. Folding it into `normalizeConfig` meant media resolution saw a
 * folder too, so a legacy path that had gone missing produced an empty library and
 * was reported as "cleared" — no media, no error, no explanation.
 *
 * @param effective - the normalized effective settings.
 * @returns the folder and the tick list to display.
 */
export function legacyFolderView(effective) {
  const declared = typeof effective?.folder === 'string' ? effective.folder.trim() : ''
  if (declared !== '') {
    return { folder: declared, selected: Array.isArray(effective?.selected) ? effective.selected : [] }
  }
  const legacy = typeof effective?.src === 'string' ? effective.src.trim() : ''
  if (legacy === '') return { folder: '', selected: [] }
  return { folder: folderFromLegacy(legacy) ?? '', selected: [basename(legacy)] }
}

/**
 * Accept a ticked-file selection: bare file names, de-duplicated and capped.
 *
 * A name that contains a path separator is dropped: the value is resolved
 * against the configured folder, and letting a separator through would make a
 * selection escape the folder the user chose.
 * @param value - the candidate selection.
 * @returns the accepted names.
 */
function normalizeSelected(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const selected = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().slice(0, MAX_SRC_LENGTH)
    if (name === '' || name.includes('/') || name.includes('\\') || seen.has(name)) continue
    seen.add(name)
    selected.push(name)
    if (selected.length >= MAX_LIBRARY) break
  }
  return selected
}

/**
 * List the playable files in a folder.
 *
 * Only formats the player can actually use are returned, so the settings page
 * never offers a file that would fail on the next start. Sorted by name for a
 * stable list between page loads.
 * @param folder - the configured folder, as stored.
 * @param dshHome - absolute DSH home directory.
 * @returns the entries, or an empty list when the folder is unusable.
 */
export function listLibrary(folder, dshHome) {
  if (typeof folder !== 'string' || folder.trim() === '') return []
  const root = toAbsolutePath(folder.trim(), dshHome)
  let names
  try {
    if (!statSync(root).isDirectory()) return []
    names = readdirSync(root)
  } catch {
    return []
  }
  const entries = []
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const extension = extensionOf(name)
    const mime = FORMATS[extension]
    if (mime === undefined) continue
    try {
      const stats = statSync(join(root, name))
      if (!stats.isFile() || stats.size > MAX_MEDIA_BYTES) continue
      entries.push({
        name,
        extension,
        kind: IMAGE_KIND.has(extension) ? 'image' : 'video',
        bytes: stats.size,
      })
    } catch {
      // An unreadable entry is simply not offered.
    }
    if (entries.length >= MAX_LIBRARY) break
  }
  return entries
}

/** @returns the lower-case extension of `file`, without the dot. */
function extensionOf(file) {
  return extname(file).replace(/^\./, '').toLowerCase()
}

/**
 * Resolve a configured media reference to an absolute file path.
 *
 * `~` and relative paths are supported because a user pasting a path into the
 * settings box should not have to spell out an absolute Windows path.
 * @param reference - the configured `src`.
 * @param dshHome - absolute DSH home directory.
 * @returns the absolute candidate path.
 */
function toAbsolutePath(reference, dshHome) {
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2))
  if (isAbsolute(reference)) return resolve(reference)
  return resolve(dshHome, reference)
}

/**
 * Describe the file to play, or why it cannot be played.
 *
 * Three input states, and the difference between the first two is the whole
 * point of this function's signature:
 *   - `undefined` — nothing has ever been chosen. The caller decides whether a
 *     bundled default applies; this function reports `configured: false` so an
 *     absent default degrades to "do not engage".
 *   - `''` — the user deliberately cleared it. Never engaged, and no bundled
 *     default may be substituted for it.
 *   - a path — resolved and validated.
 *
 * @param src - the effective `src` value, or `undefined` when never chosen.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured: false }` when nothing should play, otherwise a
 *   descriptor, possibly carrying `problem`.
 */
export function resolveMedia(src, dshHome) {
  const reference = typeof src === 'string' ? src.trim() : ''
  // Cleared or absent: the plugin does not engage — no overlay, no card, no
  // placeholder. DSH behaves exactly as if the plugin were not installed.
  if (reference === '') return { configured: false }

  const path = toAbsolutePath(reference, dshHome)
  const extension = extensionOf(path)
  const mime = FORMATS[extension]

  // Existence and file-ness are checked BEFORE the extension: they are the more
  // fundamental facts, and checking the extension first makes a directory or a
  // typo'd path report "unsupported format", which sends the user to the wrong
  // problem. Only a path that really is a file can have a meaningful format.
  if (!existsSync(path)) return { configured: true, problem: 'missing-file', extension, path }

  let stats
  try {
    stats = statSync(path)
  } catch {
    return { configured: true, problem: 'unreadable-file', extension, path }
  }
  if (!stats.isFile()) return { configured: true, problem: 'not-a-file', extension, path }
  if (mime === undefined) return { configured: true, problem: 'unsupported-format', extension, path }
  if (stats.size > MAX_MEDIA_BYTES) return { configured: true, problem: 'file-too-large', extension, path }

  return {
    configured: true,
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
    extension,
    mime,
    kind: IMAGE_KIND.has(extension) ? 'image' : 'video',
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
  }
}

/** Shared 404 body. */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('not found')
}

/**
 * Test seam for the child-process boundary.
 *
 * `tools/verify-host.mjs` replaces the runner so the picker's encoding contract
 * can be exercised without a human choosing a file in a modal dialog. Production
 * never sets it and the default is the real implementation, so there is no second
 * behaviour to drift out of sync.
 * @type {{ runCapture: ((command: string, args: string[], ctx?: unknown) => Promise<string | undefined>) | undefined }}
 */
export const __testHooks = { runCapture: undefined }

/**
 * Open the native picker, bypassing the Electron attempt.
 *
 * Exported for `tools/verify-host.mjs`: the Windows branch is the one with an
 * encoding contract worth pinning, and routing through {@link pickMediaFile}
 * would make the result depend on whether the test runner happens to be inside
 * Electron.
 * @param initial - an existing path to start the dialog at.
 * @returns the chosen path, `''` on cancel, or `undefined` when unavailable.
 */
export function pickMediaFileForTest(initial) {
  return pickViaPowerShell({ logger: { warn: () => {} } }, initial)
}

/** @returns the state file path inside the DSH home. */
function stateFile(dshHome) {
  return join(dshHome, STATE_DIRNAME, 'config.json')
}

/**
 * Read the settings-page state.
 *
 * A missing or malformed file is `{}` rather than an error: the plugin must
 * still boot with a corrupt state file, and the settings page then shows empty
 * fields the user can fix.
 * @param dshHome - absolute DSH home directory.
 * @returns the stored object, or an empty object.
 */
function readState(dshHome) {
  const file = stateFile(dshHome)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Record that a shipped clip was actually served, and reveal a hidden one.
 *
 * Called from the media route rather than from the configuration route, because
 * serving the bytes is the only proof the clip really played: the settings page
 * fetches the configuration too, and counting that would let merely opening the
 * settings page consume the first-play rule or unlock the easter egg.
 *
 * The check is on the PATH, not the file name — see `isShippedClip` for what a
 * name-only match gets wrong.
 *
 * @param dshHome - absolute DSH home directory.
 * @param media - the descriptor the media route just served.
 */
function recordBundledPlay(dshHome, media) {
  if (!isShippedClip(media, dshHome)) return
  const name = media.name
  const clip = BUNDLED_CLIPS.find((entry) => entry.name === name)
  if (clip === undefined) return
  // Read through `poolState`, NOT `readState`. Reading the raw file here would
  // recompute from the very counters `poolState` just rejected and write them
  // straight back, so the untrustworthy reveal would survive every future start.
  const { plays, openerPlays, revealed } = poolState(dshHome)
  const patch = { plays: plays + 1 }
  // ALWAYS written, even when it does not go up. Its presence is what marks a
  // state file as having been written by a version whose counting can be trusted;
  // leaving it absent until the opener happens to play would make a perfectly good
  // state file indistinguishable from the legacy one `poolState` discards.
  patch.openerPlays = clip.primary === true ? openerPlays + 1 : openerPlays
  // Written unconditionally for the same reason: a file that carried a rejected
  // reveal list is repaired in place on the first serve rather than keeping it.
  patch.unlocked = clip.hidden === true && !revealed.includes(name) ? [...revealed, name] : revealed
  try {
    patchState(dshHome, patch)
  } catch {
    // Losing the count is survivable: the worst case is the opener playing once
    // more, or the egg staying hidden one launch longer.
  }
}

/**
 * Write the state file atomically, replacing only the keys given.
 *
 * @param dshHome - absolute DSH home directory.
 * @param patch - the keys to merge in.
 */
function patchState(dshHome, patch) {
  const file = stateFile(dshHome)
  const temporary = `${file}.tmp`
  const next = { ...readState(dshHome), ...patch }
  mkdirSync(join(dshHome, STATE_DIRNAME), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * Replace the stored `src` — and optionally the boolean switches — atomically,
 * so a crash mid-write cannot leave a half-written state file that breaks the
 * next boot.
 *
 * A switch is only written when it arrived as a boolean: the settings page sends
 * every switch on every save, but an older client sending only `src` must not
 * clear a value the profile's patch row set.
 * @param dshHome - absolute DSH home directory.
 * @param src - the new path, or `''` to clear it.
 * @param switches - boolean values to store; anything else is left alone.
 */
function writeState(dshHome, src, switches, extras) {
  const dir = join(dshHome, STATE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const file = stateFile(dshHome)
  const temporary = `${file}.tmp`
  const next = { ...readState(dshHome) }
  // Only a string replaces the stored path. `undefined` means the request said
  // nothing about it, and leaving it untouched is the whole point: see the save
  // route for what conflating the two cost.
  if (typeof src === 'string') next.src = src
  for (const key of SWITCH_KEYS) {
    if (typeof switches?.[key] === 'boolean') next[key] = switches[key]
  }
  // Folder and selection are written only when the caller sent them, for the
  // same reason the switches are: a client that predates the feature must not
  // wipe the configuration it does not know about.
  if (typeof extras?.folder === 'string') next.folder = extras.folder.trim().slice(0, MAX_SRC_LENGTH)
  if (Array.isArray(extras?.selected)) next.selected = normalizeSelected(extras.selected)
  // Enumerated settings the page can change, validated HERE rather than trusted:
  // `normalizeConfig` would coerce a bad value back to the default on read, which
  // would leave junk sitting in the file and the page showing something else.
  if (typeof extras?.skip === 'string' && SKIP_MODES.has(extras.skip)) next.skip = extras.skip
  // A folder supersedes the single path: leaving the old one behind would let it
  // reappear as the fallback if the folder is later emptied.
  if (typeof extras?.folder === 'string' && extras.folder.trim() !== '') next.src = ''
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** Slack added to the splash's own estimate before the safety release fires. */
const FULLSCREEN_SAFETY_SLACK_MS = 15000

/**
 * Electron's `BrowserWindow`, or `undefined` on a host without Electron.
 *
 * Loaded the same way the file picker loads Electron, and for the same reason:
 * this package must resolve with zero dependencies, so the module is requested
 * at call time and a failure simply means "this host has no desktop window".
 * @returns the constructor, or `undefined`.
 */
async function electronBrowserWindow() {
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const electron = require('electron')
    const api = electron.BrowserWindow ?? electron.default?.BrowserWindow
    return typeof api === 'function' ? api : undefined
  } catch {
    return undefined
  }
}

/**
 * Every live Electron window the splash may legitimately resize.
 *
 * The welcome and login windows declare `fullscreenable: false`, so they are
 * filtered out by asking the window itself rather than by guessing at titles.
 * @returns the candidate windows, or an empty list.
 */
async function electronWindows() {
  const BrowserWindow = await electronBrowserWindow()
  if (BrowserWindow === undefined) return []
  try {
    return BrowserWindow.getAllWindows().filter((win) => {
      try {
        if (win.isDestroyed?.() === true) return false
        if (typeof win.isFullScreenable === 'function' && win.isFullScreenable() === false) return false
        return true
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** @returns Electron's focused window, or `undefined`. */
async function electronFocusedWindow() {
  const BrowserWindow = await electronBrowserWindow()
  if (BrowserWindow === undefined || typeof BrowserWindow.getFocusedWindow !== 'function') return undefined
  try {
    return BrowserWindow.getFocusedWindow() ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Choose the window the DSH page is in.
 *
 * Preferring the focused window is right when the user is looking at DSH, and
 * matching the loopback URL is the tie-breaker that still finds it when the
 * splash runs during a reload in a background window. `getURL` is only a hint:
 * a window with no reachable `webContents` falls through rather than throwing.
 * @param list - candidate windows.
 * @param focused - the focused window, when there is one.
 * @returns the chosen window, or `undefined` for an empty list.
 */
function pickSplashWindow(list, focused) {
  if (focused !== undefined && list.includes(focused)) return focused
  const served = list.find((win) => {
    try {
      const url = String(win.webContents?.getURL?.() ?? '')
      return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i.test(url)
    } catch {
      return false
    }
  })
  return served ?? list[0]
}

/**
 * Run the bundled PowerShell maximiser.
 *
 * @param processName - executable name owning the window, without the extension.
 * @returns one of none / already / maximized / refused, or undefined when the
 *   helper or PowerShell itself is unavailable.
 */
function maximizeViaPowerShell(processName) {
  const script = join(PACKAGE_DIR, 'tools', 'maximize-window.ps1')
  if (!existsSync(script)) return Promise.resolve(undefined)
  if (process.platform !== 'win32') return Promise.resolve(undefined)
  return (__testHooks.runCapture ?? runCapture)('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-ProcessName', processName,
  ], { logger: { warn: () => {} } }).then((output) => {
    // The script prints exactly one word; anything else means it did not run.
    const word = typeof output === 'string' ? output.trim().split(/\r?\n/).pop() : undefined
    return ['none', 'already', 'maximized', 'refused'].includes(word) ? word : undefined
  })
}

/**
 * Maximise the DSH window once, at application start.
 *
 * The Host cannot do this through Electron: it is a plain Node child process
 * (ELECTRON_RUN_AS_NODE=1), so the windows — owned by the Electron main
 * process — are not reachable, and the desktop shell exposes no IPC that changes
 * window geometry. What is left is a Win32 call from the Host's own PowerShell,
 * the same mechanism the file picker already relies on. Consequences: Windows
 * only, and the window is driven from outside the application.
 *
 * @param deps - override seams for the test suite.
 * @returns the once/done controller.
 */
export function createStartMaximized({
  run = maximizeViaPowerShell,
  processName = basename(process.execPath, '.exe'),
} = {}) {
  let done = false

  /**
   * Apply the start-up window state at most once.
   * @returns whether this call maximized the window.
   */
  const once = async () => {
    if (done) return false
    let result
    try {
      result = await run(processName)
    } catch {
      result = undefined
    }
    // No window found is the one outcome that does NOT count as handled: the
    // window may simply not exist yet, and the next page load is a fine second
    // chance. Every other outcome is a decision about a real window.
    if (result === 'none' || result === undefined) return false
    done = true
    return result === 'maximized'
  }

  return { once, done: () => done }
}

/**
 * Parse one `Range` request header against a known media length.
 * @param header - the raw `Range` header.
 * @param size - the total media length in bytes.
 * @returns the inclusive byte range, or `undefined` for a malformed or unsatisfiable header.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    if (rawEnd === '') return undefined
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined
  return { start, end }
}

/**
 * Stream one resolved media file, honouring `Range` and conditional requests.
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param media - a descriptor from {@link resolveMedia}.
 */
function serveMedia(req, res, media) {
  const headers = {
    'Content-Type': media.mime,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': SEEKABLE.has(media.mime) ? 'bytes' : 'none',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${media.mtimeMs.toString(36)}-${media.bytes.toString(36)}"`,
  }

  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const seekable = SEEKABLE.has(media.mime)
  const range = seekable ? parseRange(req.headers.range, media.bytes) : undefined
  if (seekable && req.headers.range !== undefined && range === undefined) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${media.bytes}` })
    res.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? media.bytes - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'Content-Length': String(end - start + 1),
    ...range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${media.bytes}` },
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(media.path, { start, end })
  let failed = false
  stream.on('error', () => {
    failed = true
    try {
      res.destroy()
    } catch { /* the socket may already be gone */ }
  })
  res.on('close', () => {
    if (!failed) stream.destroy()
  })
  stream.pipe(res)
}

/**
 * Read a JSON request body with a hard size ceiling.
 * @param req - the HTTP request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed body, or `undefined` when it is absent, oversized, or not JSON.
 */
function readJsonBody(req, limit) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * Open a native file dialog and resolve the chosen path.
 *
 * Chain, most native first:
 *   1. Electron's own dialog — the DSH Desktop host runs inside Electron, so
 *      this needs no child process at all. Probed at call time because the same
 *      plugin also runs under the plain Node CLI host.
 *   2. Windows PowerShell WinForms — `powershell.exe` ships with Windows and
 *      WinForms with the .NET runtime it loads, so this needs no dependency.
 *   3. macOS `osascript`, Linux `zenity`.
 *   4. Nothing — the settings page keeps its text field, which always works.
 *
 * @param ctx - the plugin context, used for logging.
 * @param initial - an existing path to start the dialog at.
 * @returns the chosen absolute path, or `undefined` on cancel or unsupported host.
 */
async function pickMediaFile(ctx, initial, mode = 'file') {
  const electronResult = await pickViaElectron(initial, mode)
  if (electronResult !== undefined) return electronResult
  if (process.platform === 'win32') return pickViaPowerShell(ctx, initial, mode)
  if (process.platform === 'darwin') return pickViaOsa(initial)
  return pickViaZenity(initial)
}

/**
 * Try Electron's native dialog.
 * @param initial - starting path.
 * @returns the path, `''` for a cancel, or `undefined` when Electron is absent.
 */
async function pickViaElectron(initial) {
  if (process.versions.electron === undefined && process.type === undefined) return undefined
  let dialog
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    dialog = (require('electron').dialog ?? require('electron/main')?.dialog)
  } catch {
    return undefined
  }
  if (dialog === undefined || typeof dialog.showOpenDialog !== 'function') return undefined
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select a video or animated image for the DSH splash',
      properties: ['openFile'],
      defaultPath: initial === '' ? undefined : initial,
      filters: [
        { name: 'All supported media', extensions: [...Object.keys(FORMATS)] },
        { name: 'Video', extensions: Object.keys(FORMATS).filter((extension) => !IMAGE_KIND.has(extension)) },
        { name: 'Animated / still image', extensions: [...IMAGE_KIND] },
      ],
    })
    if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch {
    return undefined
  }
}

/**
 * Where this plugin's media is meant to live.
 *
 * The folder picker starts here when nothing is configured yet, so the dialog
 * opens on the folder the settings page and the README both name rather than
 * wherever the last dialog happened to be.
 *
 * @param dshHome - absolute DSH home directory.
 * @returns the absolute recommended media directory.
 */
export function defaultMediaDir(dshHome) {
  return join(dshHome, STATE_DIRNAME, 'media')
}

/**
 * Run the bundled PowerShell picker.
 * @param ctx - the plugin context.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` when unavailable.
 */
function pickViaPowerShell(ctx, initial, mode = 'file') {
  const script = join(PACKAGE_DIR, 'tools', 'pick-media-file.ps1')
  if (!existsSync(script)) {
    ctx.logger.warn('dsh-splash-animation: tools/pick-media-file.ps1 is missing from the installed package; the settings page keeps its text field.')
    return Promise.resolve(undefined)
  }
  // A folder dialog starts AT the folder it was given; a file dialog starts in
  // the folder the file lives in, with the name prefilled. Taking `dirname` for
  // both is what made the folder picker open one level too high.
  const startDir = initial === '' ? '' : (mode === 'folder' ? initial : dirname(initial))
  const startFile = initial === '' || mode === 'folder' ? '' : initial.slice(initial.lastIndexOf(sep) + 1)
  const carrier = join(tmpdir(), `dsh-splash-pick-${process.pid}-${Date.now()}.txt`)
  return (__testHooks.runCapture ?? runCapture)('powershell.exe', [
    '-NoProfile',
    // STA is required: the common file dialog is a COM object and throws on an
    // MTA thread. Windows PowerShell 5.1 already defaults to STA, but passing it
    // keeps the contract explicit and survives a `pwsh` 7 being first on PATH.
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutFile', carrier,
    '-InitialDirectory', startDir,
    '-InitialFile', startFile,
    '-Mode', mode,
    // The title carries the localized text because the script must stay pure
    // ASCII: Windows PowerShell decodes a BOM-less script as ANSI, so a Chinese
    // string literal in it is read as the wrong bytes and the script fails to
    // parse. Node is UTF-8 clean, so the string travels safely as an argument.
    '-Title', mode === 'folder' ? '选择素材文件夹' : '选择视频或动图',
  ], ctx).then((output) => {
    if (output === undefined) return undefined
    // The chosen path travels through a UTF-8 FILE, not stdout: a console encodes
    // text with the system ANSI code page, so a path containing non-ASCII
    // characters arrives as mojibake when decoded as UTF-8. A file carries its own
    // encoding, which removes the code page from the path entirely. stdout is now
    // only a success signal.
    try {
      if (!existsSync(carrier)) return ''
      return readFileSync(carrier, 'utf8').replace(/^\uFEFF/, '').trim()
    } catch {
      return undefined
    } finally {
      try {
        unlinkSync(carrier)
      } catch { /* the picker may never have created it, or it is already gone */ }
    }
  })
}

/**
 * macOS fallback through AppleScript.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` on failure.
 */
function pickViaOsa(initial) {
  const prompt = 'Select a video or animated image for the DSH splash'
  const args = initial === ''
    ? ['-e', `POSIX path of (choose file with prompt "${prompt}")`]
    : ['-e', `POSIX path of (choose file with prompt "${prompt}" default location POSIX file "${initial}")`]
  return runCapture('osascript', args).then((output) => (output === undefined ? undefined : output.trim()))
}

/**
 * Linux fallback through zenity.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` when zenity is absent.
 */
function pickViaZenity(initial) {
  return runCapture('zenity', [
    '--file-selection',
    '--title=Select a video or animated image for the DSH splash',
    ...initial === '' ? [] : [`--filename=${initial}`],
  ]).then((output) => (output === undefined ? undefined : output.trim()))
}

/**
 * Run a child process with a timeout, capturing stdout as UTF-8.
 *
 * Chunks are collected as buffers and decoded once at the end. `out += chunk`
 * would decode each chunk separately, so a multi-byte character straddling a
 * chunk boundary becomes replacement characters — the same class of bug as
 * reading a path through a console code page.
 * @param command - the executable.
 * @param args - its arguments.
 * @param ctx - optional context for diagnostics.
 * @returns the decoded stdout, or `undefined` when the process failed, timed out, or was unavailable.
 */
function runCapture(command, args, ctx) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolveRun(undefined)
      return
    }
    const outChunks = []
    let err = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch { /* already gone */ }
      finish(undefined)
    }, PICK_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (ctx !== undefined) ctx.logger.warn(`dsh-splash-animation: ${command} could not be started (${error.code ?? error.message}); the settings page keeps its text field.`)
      finish(undefined)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        if (ctx !== undefined && err.trim() !== '') ctx.logger.warn(`dsh-splash-animation: ${command} exited ${code}: ${err.trim().slice(0, 400)}`)
        // A non-zero code is an environment problem, never a user cancel; the
        // settings page reports it as such.
        return finish(undefined)
      }
      finish(Buffer.concat(outChunks).toString('utf8'))
    })
  })
}

/**
 * Mount the splash animation.
 *
 * The route table and the state file are the only mutations; every route
 * registration is disposed with the plugin fiber, so an HMR reload or a profile
 * change leaves no route behind.
 * @param ctx - the plugin context.
 * @param rawConfig - the row `config` as written in YAML.
 * @param options - test seam only: `picker` replaces the native file dialog, so
 *   the pick route's response handling can be verified without a human clicking
 *   a modal window. Production callers omit it.
 */
export function apply(ctx, rawConfig, options = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchConfig = normalizeConfig(rawConfig)
  const pick = options.picker ?? ((initial, mode) => pickMediaFile(ctx, initial, mode))
  // Create the recommended media folder on the way up. The README tells users to
  // keep their clips here, and the folder picker opens here — but a directory that
  // does not exist is skipped by the dialog helper, which then silently falls back
  // to whatever Windows last remembered. A fresh install therefore landed on
  // Documents the first time anyone pressed the button.
  try {
    mkdirSync(defaultMediaDir(dshHome), { recursive: true })
  } catch {
    // A read-only home is not fatal: the folder is a convenience, not a requirement.
  }
  const startMaximized = options.maximize ?? createStartMaximized({
    run: options.run,
    processName: options.processName,
  })
  // Say once, at the only moment it is useful, that the plugin ships nothing it
  // did not make. `postinstall` prints the same thing, but pnpm 10+ blocks
  // dependency build scripts unless they are approved, so relying on that alone
  // would mean most users never hear about the optional clips.
  // Optional call: `info` is not part of the logger contract this plugin already
  // relies on (`warn` is), and a throw here would take the whole mount down — a
  // missing notice is not worth failing to load over.
  ctx.logger?.info?.(
    'dsh-splash-animation: 自带 3 段自制二创（PRTS ×2、普鲸 ×1）。另有 3 段第三方开机动画（作者 lxj5820，MIT，'
    + 'https://github.com/lxj5820/dsh-boot-animation）默认不安装 —— 想要就运行 node tools/optional-media.mjs --fetch。',
  )

  /**
   * Effective settings: patch row, then the settings-page file on top.
   *
   * Re-read per request rather than cached at mount, so a change made in the
   * settings page is picked up by the next page load without restarting DSH.
   * @returns the merged, normalized configuration.
   */
  const settings = () => {
    const stored = readState(dshHome)
    const merged = { ...patchConfig }
    for (const [key, value] of Object.entries(stored)) {
      if (key in DEFAULTS) merged[key] = value
    }
    return normalizeConfig(merged)
  }

  /**
   * The shipped pool, plus what previous starts have left behind.
   *
   * Read per request for the same reason `settings()` is: a page load has to see
   * the counts the previous splash wrote, or the opener would play forever and the
   * pool would never be drawn.
   *
   * `openerPlays` counts the opener specifically, because the guarantee is worded
   * in terms of IT — "three starts of PRTS, then the whale" — and `plays` counts
   * every shipped serve, which is a different number the moment the egg appears.
   */
  const pool = () => ({
    entries: bundledClipEntries(dshHome),
    ...poolState(dshHome),
  })

  // Suppress the shell's own boot layer while our splash owns the screen, and
  // cover the application until the splash has painted.
  //
  // The startup order is: the native splash window → the harness starts → the web
  // page loads → the shell paints `[data-dsh-boot]` ("Loading plugins…") → our
  // client module loads and the overlay appears. That middle step is visible as a
  // second loading screen between the native splash and the video, so it is
  // hidden for as long as our splash is going to cover the screen anyway.
  //
  // The rule targets `[data-dsh-boot]:has([data-dsh-boot-spinner])`, not the boot
  // container itself: that container also renders plugin-load FAILURES, and a
  // hidden failure report would turn a diagnosable broken plugin into a blank
  // screen. `:has()` is supported by every Electron that ships a DSH build.
  //
  // The handler is registered synchronously, before anything awaits: the injected
  // row table is collected at host startup, so a handler registered after that
  // collection never contributes. This is why it is the first statement.
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const effective = settings()
      const media = resolveEffectiveMedia(pickEffectiveSource(effective, dshHome), dshHome)
      // Nothing to play (or nothing playable) means the shell's own boot screen is
      // the only thing the user would see: leave it alone.
      if (media.configured !== true || media.problem !== undefined) return
      const alreadyPresent = table.some((row) => row && row.kind === 'style' && typeof row.text === 'string' && row.text.includes('dsh-splash-animation-boot'))
      if (alreadyPresent) return
      // Three rules, and the release mechanism is the whole point — an earlier
      // attempt used a self-cancelling SELECTOR and locked the interface away (see
      // `COVER_MARKERS` in client.js).
      //
      // Plugin client modules are delivered in batches, so this one executes a second
      // or two after the page starts, while anything inline in index.html has already
      // run (the whale widget, for one, and it paints a body-level fixed element of
      // its own).
      //
      // The shell's own stylesheet paints `body{background-color:#fff}` in light mode
      // and `#151517` in dark mode, and its boot layer is a JS-created element inside
      // `#root`. Hiding the boot layer and `#root` therefore leaves the BODY's
      // background on screen, white on a light-mode machine, for as long as the page
      // takes to reach this module — a flash of light that reads as "the interface
      // appeared and then vanished".
      //
      // So: suppress the boot layer, cover the application, and force the base colour
      // dark. All three sit in the served HTML, so they apply from the first paint
      // rather than from this module.
      //
      // The cover and the base colour are removed by the client, exactly once, when
      // it has the splash mounted. Nothing re-applies them: the elements are gone
      // from the document, so they cannot come back when the splash later unmounts.
      // That one-way property is what the previous attempt lacked.
      table.push({
        kind: 'style',
        text: '/* dsh-splash-animation-boot */ [data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}'
          + '/* dsh-splash-animation-cover */ #root{visibility:hidden!important}'
          + '/* dsh-splash-animation-base */ html,body{background-color:#000!important}',
      })

      // A bounded way out if the client module never runs.
      //
      // The cover above is removed by client.js, which is the point — a release the
      // client owns is one-way and cannot re-arm. But "the client always runs" is an
      // assumption, and if it is wrong the outcome is the worst kind: `#root` hidden
      // and the boot layer suppressed together leave a black screen with no way back,
      // because the shell's own failure report renders inside `#root` too.
      //
      // So a fresh inline script arms a fresh timer on every page load and takes the
      // rules away if nobody else has. A NEW script element per load is what makes
      // this safe: a re-served CSS `animation-delay` would accumulate across reloads
      // and eventually release the cover immediately, which is why the cover carries
      // no timer of its own. The timeout is generous on purpose — this must never
      // fire during a slow but healthy start, because firing early is a visible
      // flash, while firing late only shortens an already-broken black screen.
      table.push({
        kind: 'script',
        placement: 'head',
        text: '/* dsh-splash-animation-guard */'
          + 'try{'
          + 'var m=["dsh-splash-animation-cover","dsh-splash-animation-base"];'
          + 'var go=function(){try{'
          + 'var ss=document.head?document.head.getElementsByTagName("style"):[],doomed=[];'
          + 'for(var i=0;i<ss.length;i++){var x=ss[i].textContent||"";'
          + 'for(var j=0;j<m.length;j++){if(x.indexOf(m[j])!==-1){doomed.push(ss[i]);break}}}'
          + 'for(var k=0;k<doomed.length;k++){doomed[k].remove()}}catch(e){}};'
          + 'var t=setTimeout(go,10000);'
          + 'globalThis.__DSH_SPLASH_COVER_GUARD__={release:go,clear:function(){clearTimeout(t)}}'
          + '}catch(e){}',
      })
    } catch { /* a broken settings read must not break index rendering */ }
  })

  ctx.inject(['webServer'], (scoped) => {
    /** The trust fence needs the request, so each handler asks per request. */
    const rejectionFor = (req) => {
      let connection
      try {
        connection = scoped.get('connection')
      } catch {
        connection = undefined
      }
      if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
      return connection.requestRejection(req)
    }

    /** Reject anything that is not this machine's own authenticated client. */
    const guard = (req, res) => {
      const rejection = rejectionFor(req)
      if (rejection === undefined) return false
      res.writeHead(rejection)
      res.end()
      return true
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        const effective = settings()
        const media = labelShipped(resolveEffectiveMedia(pickEffectiveSource(effective, dshHome, Math.random, pool()), dshHome), dshHome)
        const view = legacyFolderView(effective)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({
          version: 4,
          settings: effective,
          // `configured: false` is the signal to the browser half to stay out of
          // the way entirely — no overlay, no card, nothing.
          media: media.configured !== true
            ? { kind: 'none' }
            : media.problem === undefined
              ? {
                  url: `${MEDIA_ROUTE}/${encodeURIComponent(media.name)}`,
                  name: media.name,
                  kind: media.kind,
                  mime: media.mime,
                  extension: media.extension,
                  bytes: media.bytes,
                }
              : { kind: 'none', name: media.name, extension: media.extension },
          problem: media.problem ?? null,
          /** Which rule chose the media: `bundled`, `chosen`, `cleared` or `unset`. */
          source: media.source ?? null,
          /**
           * What the settings page should show in its path field.
           *
           * A never-chosen install still plays the bundled video, so the field is
           * prefilled with that path — the page shows what is actually playing
           * rather than an empty box that contradicts it. Saving clears the
           * `bundled` source, which is what "the user has now chosen" means.
           */
          effectiveSrc: media.source === 'bundled'
            ? BUNDLED_MEDIA
            : (media.source === 'chosen' && media.configured === true ? (effective.src ?? '') : ''),
          /** True once the user has chosen (or explicitly cleared) something. */
          chosen: media.source === 'chosen' || media.source === 'cleared',
          /**
           * What the settings page lists: the playable files in the folder.
           *
           * Sent with the configuration rather than from a route of its own —
           * the page already fetches this one, and a second round trip would only
           * add a way for the two to disagree.
           */
          library: listLibrary(effective.folder, dshHome),
          /**
           * The clips the package ships, listed separately and NOT tickable.
           *
           * They used to be merged into `library`, which made one list carry two
           * opposite meanings for "nothing ticked" — the folder's ("play nothing")
           * and the pool's ("play everything") — under a heading that named only
           * the folder. Splitting them is what removes the contradiction.
           */
          shipped: shippedLibrary(dshHome),
          /**
           * The folder and tick list as the page should show them.
           *
           * A view, not a rewrite: `effective` keeps the legacy `src` intact so a
           * path that has gone missing is still reported as `missing-file`.
           */
          effectiveFolder: view.folder,
          effectiveSelected: view.selected,
        }))
      },
    }))

    // The settings page owns the stored `src`; this route is the only writer.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 16 * 1024)
        // A body without `src` is fine — the settings page no longer edits the
        // single path. A body with a `src` that is not a string is malformed.
        if (body === undefined || (body.src !== undefined && typeof body.src !== 'string')) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        // `src` is written ONLY when the body actually carries one. Absent means
        // "this request says nothing about the single path", which is not the same
        // as "clear it" — and conflating the two is what made the settings page
        // destroy playback: every switch toggle sent `src: ''`, the Host stored a
        // deliberate "cleared", and the splash went permanently silent with no way
        // back through the UI.
        const src = typeof body.src === 'string' ? body.src.trim().slice(0, MAX_SRC_LENGTH) : undefined
        // Optional: an older client sends only `src`, which must leave the stored
        // switches untouched rather than resetting them. Anything that is not a
        // boolean is dropped here, so a malformed body cannot store junk.
        const switches = {}
        for (const key of SWITCH_KEYS) {
          if (typeof body[key] === 'boolean') switches[key] = body[key]
        }
        try {
          writeState(dshHome, src, switches, { folder: body.folder, selected: body.selected, skip: body.skip })
        } catch (error) {
          ctx.logger.warn(`dsh-splash-animation: could not write the state file (${error.code ?? error.message})`)
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'write-failed' }))
          return
        }
        // Saving — including saving an empty path — records an explicit choice, so
        // the bundled default no longer applies afterwards. That is what makes
        // "clear it and it stops playing" true.
        const media = labelShipped(resolveEffectiveMedia(pickEffectiveSource(settings(), dshHome, Math.random, pool()), dshHome), dshHome)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          // The same wire version as the config route: the settings page consumes
          // both responses with one parser.
          version: 4,
          settings: { ...patchConfig, ...readState(dshHome) },
          media: media.configured !== true || media.problem !== undefined
            ? { kind: 'none', name: media.name, extension: media.extension }
            : {
                url: `${MEDIA_ROUTE}/${encodeURIComponent(media.name)}`,
                name: media.name,
                kind: media.kind,
                mime: media.mime,
                extension: media.extension,
                bytes: media.bytes,
              },
          problem: media.problem ?? null,
          source: media.source ?? null,
          effectiveSrc: media.configured === true ? src : '',
          chosen: true,
        }))
      },
    }))

    // The splash's own lifetime, reported by the only half that can see it.
    //
    // Fullscreen is requested here rather than at injection time on purpose: the
    // request then cannot arrive from a client that is not actually showing a
    // splash, so a broken browser half leaves the window exactly as it found it.
    scoped.effect(() => {
      const registration = scoped.webServer.register({
        kind: 'exact',
        path: SPLASH_ROUTE,
        handler: async (req, res) => {
          if (guard(req, res)) return
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' })
            res.end()
            return
          }
          const body = await readJsonBody(req, 4 * 1024)
          if (body === undefined || !SPLASH_PHASES.includes(body.phase)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
            return
          }
          // The only phase the Host acts on. The browser half reports `startup`
          // on every page load; `once()` is what makes that mean the application
          // rather than the page, so a reload never re-maximises a window the
          // user has just restored.
          const maximized = body.phase === 'startup' && settings().startMaximized === true
            ? await startMaximized.once()
            : false
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ ok: true, maximized }))
        },
      })
      return () => {
        // `webServer.register` returns the disposer FUNCTION itself, not an object
        // with `dispose` — and each disposer deletes its route BY PATH. Getting
        // this wrong is not a leak of one route: on a profile recomposition the
        // new fiber registers every path while the old fiber is still disposing,
        // so a stale disposer deletes the route the new fiber just installed.
        // That is exactly how the settings card lost `/config.json` and started
        // reporting "读不到插件配置".
        try {
          if (typeof registration === 'function') registration()
          else registration?.dispose?.()
        } catch {
          // The route is already gone; there is nothing left to undo.
        }
      }
    })

    // Opens a native dialog in the Host process; the browser cannot read a local
    // file path, so the pick has to happen here.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: PICK_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        // Folder is the default: the settings page chooses a folder and lists what
        // is inside it, so a client that sends no mode means "folder". `mode:
        // 'file'` still reaches the single-file dialog.
        //
        // The body has to be READ before it can be consulted — an earlier version
        // referenced an undeclared `body` here, which in strict mode throws on
        // every call and surfaced as the generic "could not read the settings"
        // error the moment anyone pressed the button.
        const body = await readJsonBody(req, 4 * 1024)
        const mode = body?.mode === 'file' ? 'file' : 'folder'
        const effective = settings()
        // A folder dialog must open ON the media folder. Sending `src` for both
        // modes opened it wherever Windows last remembered, because configuring a
        // folder clears `src` — and with nothing configured at all the sensible
        // place to land is the folder this plugin tells users to keep media in.
        const initial = mode === 'folder'
          ? (effective.folder ?? defaultMediaDir(dshHome))
          : (effective.src ?? '')
        const chosen = await pick(initial, mode)
        // `undefined` means this host has no dialog at all; the settings page
        // then says so and points at the text field.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(chosen === undefined ? { ok: false, error: 'picker-unavailable' } : { ok: true, path: chosen }))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: MEDIA_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        let requested
        try {
          requested = decodeURIComponent(String(req.url ?? '').slice(MEDIA_ROUTE.length).replace(/^\//, '').split('?')[0])
        } catch {
          notFound(res)
          return
        }
        // Resolved through the same eligible set the configuration route picked
        // from, so whatever it announced as `media.url` is exactly what is served
        // here. Checking `settings().src` instead was a 404 on every start once
        // the folder took over.
        const media = resolveRequestedMedia(settings(), dshHome, requested)
        if (media === undefined) {
          notFound(res)
          return
        }
        // Count the play here, not in the configuration route: serving the bytes
        // is the only proof the clip really played, and the settings page reads
        // the configuration too. A ranged request continues a playback that has
        // already been counted, so only a fresh one (no Range, or one starting at
        // byte 0) counts.
        const range = req.headers?.range
        if (typeof range !== 'string' || /^bytes=0-/.test(range.trim())) {
          recordBundledPlay(dshHome, media)
        }
        serveMedia(req, res, media)
      },
    }))
  })
}
