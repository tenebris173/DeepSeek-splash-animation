/**
 * Does the splash actually let go of the screen?
 *
 * Every other suite in this repository reads the source, or renders one frame of
 * it. That is how 0.8.0 shipped an application that could not be clicked:
 *
 *   the unmount effect required `phase === 'out'` AND `session.phase === 'out'`,
 *   `dismiss()` advanced only `phase`, and nothing anywhere wrote `'out'` into the
 *   session. The fade timer was therefore never armed, the session never reached
 *   `'done'`, and the overlay stayed mounted — invisible (`opacity: 0`),
 *   full-viewport, `pointer-events: auto` — with its `window`-level capture
 *   listeners still installed, stopping every pointer event before it reached the
 *   application. No error, no log line, no hung process: a perfectly rendered
 *   interface that could not be clicked.
 *
 * Syntax checks and single-frame renders cannot see any of that. This suite drives
 * the REAL component through the whole lifecycle with a hand-written React stand-in
 * — state, effects, dependency comparison, unmount — and asserts the only thing
 * that matters to the user: after the splash has been dismissed, the application
 * gets its clicks back.
 *
 * Run it against a known-broken build to confirm it has teeth:
 *
 *   node tools/verify-dismissal.mjs --client ../backups/.../client.js
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const PACKAGE_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)))
const clientFlag = process.argv.indexOf('--client')
const CLIENT_PATH = clientFlag === -1 ? join(PACKAGE_DIR, 'client.js') : resolve(process.argv[clientFlag + 1])

const results = []
/**
 * Record one assertion.
 * @param ok - whether it held.
 * @param label - the assertion as it reads when passing.
 * @param detail - extra context, printed only for the assertion as written.
 */
function check(ok, label, detail) {
  results.push({ ok: Boolean(ok), label, detail })
}

const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * One isolated world: a React stand-in, a window, a document and a clock.
 *
 * Deliberately small. It implements exactly the parts of React this component
 * uses — `useState` with working setters, `useRef`, `useCallback`, and effects
 * that honour dependency arrays and run their cleanups — plus the `window`
 * surface the splash touches. Nothing is simulated that the component does not
 * call, so a hook the component adds later shows up as a loud failure here rather
 * than as a silent pass.
 * @param wire - the payload both transports answer with.
 */
function createWorld() {
  const hooks = []
  const windowListeners = []
  const timers = []
  const portals = []
  let cursor = 0
  let dirty = false
  let touches = []
  let clock = 0
  let nextTimerId = 1
  let renders = 0
  let output
  const trace = []

  function useState(initial) {
    const index = cursor++
    let slot = hooks[index]
    if (slot === undefined || slot.kind !== 'state') {
      slot = hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      dirty = true
    }
    return [slot.value, set]
  }

  function useRef(initial) {
    const index = cursor++
    let slot = hooks[index]
    if (slot === undefined || slot.kind !== 'ref') slot = hooks[index] = { kind: 'ref', ref: { current: initial } }
    return slot.ref
  }

  function useCallback(fn, deps) {
    const index = cursor++
    let slot = hooks[index]
    if (slot === undefined || slot.kind !== 'callback' || !sameDeps(slot.deps, deps)) {
      slot = hooks[index] = { kind: 'callback', fn, deps }
    }
    return slot.fn
  }

  function useMemo(fn, deps) {
    const index = cursor++
    let slot = hooks[index]
    if (slot === undefined || slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
      slot = hooks[index] = { kind: 'memo', value: fn(), deps }
    }
    return slot.value
  }

  const makeEffect = (layout) => (fn, deps) => {
    const index = cursor++
    let slot = hooks[index]
    if (slot === undefined || slot.kind !== 'effect') {
      slot = hooks[index] = { kind: 'effect', deps: undefined, cleanup: undefined }
    }
    slot.fn = fn
    slot.layout = layout
    slot.incoming = deps === undefined ? undefined : deps.slice()
    touches.push(index)
  }

  function commitEffects() {
    for (const index of touches) {
      const slot = hooks[index]
      const changed = slot.incoming === undefined || !sameDeps(slot.deps, slot.incoming)
      if (!changed) continue
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.deps = slot.incoming
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  function render() {
    cursor = 0
    touches = []
    renders += 1
    output = currentComponent()
    commitEffects()
    trace.push(`render#${renders} session=${hooks[0]?.value?.phase} phase=${hooks[1]?.value} opaque=${output === null ? 'unmounted' : output?.props?.style?.opacity}`)
  }

  function flush() {
    for (let guard = 0; guard < 500 && dirty; guard += 1) {
      dirty = false
      render()
    }
  }

  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    addEventListener(type, fn, capture) {
      windowListeners.push({ type, fn, capture: Boolean(capture), removed: false })
    },
    removeEventListener(type, fn, capture) {
      const found = windowListeners.find(
        (entry) => !entry.removed && entry.type === type && entry.fn === fn && entry.capture === Boolean(capture),
      )
      if (found !== undefined) found.removed = true
    },
    setTimeout(fn, ms) {
      const delay = Math.max(0, Number(ms) || 0)
      const id = nextTimerId++
      timers.push({ id, fn, delay, at: clock + delay, cleared: false, fired: false })
      trace.push(`arm(${delay})`)
      return id
    },
    clearTimeout(id) {
      const found = timers.find((entry) => entry.id === id)
      if (found !== undefined) found.cleared = true
    },
    location: { href: 'http://127.0.0.1:19387/' },
  }

  const headStyle = {
    textContent: '/* dsh-splash-animation-cover */ #root{visibility:hidden!important}',
    removed: false,
    parentNode: null,
    remove() {
      this.removed = true
    },
  }

  const document = {
    body: { nodeType: 1 },
    head: { getElementsByTagName: (name) => (name === 'style' ? [headStyle] : []) },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        canPlayType: () => '',
        style: {},
        addEventListener() {},
        removeEventListener() {},
      }
    },
    querySelectorAll: () => [],
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
    useState,
    useRef,
    useCallback,
    useMemo,
    useEffect: makeEffect(false),
    useLayoutEffect: makeEffect(true),
  }

  let registration

  return {
    React,
    window,
    document,
    portals,
    windowListeners,
    timers,
    trace,
    get renders() {
      return renders
    },
    get output() {
      return output
    },
    get registration() {
      return registration
    },
    setComponent(component) {
      currentComponent = component
    },
    mount() {
      dirty = true
      flush()
    },
    flush,
    /** Fire every timer due within `ms`, re-rendering as the component reacts. */
    advance(ms) {
      const target = clock + ms
      // Anything already queued by an event handler commits before the clock moves.
      flush()
      for (;;) {
        const due = timers
          .filter((entry) => !entry.cleared && !entry.fired && entry.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        clock = due.at
        due.fired = true
        due.fn()
        flush()
      }
      clock = target
      flush()
    },
    /**
     * Deliver an event the way the browser would, then report whether the
     * application saw it.
     *
     * The splash's listeners are on `window` in the CAPTURE phase, so they run
     * before anything else and their `stopPropagation()` is what starves the
     * application. Listeners on `window` itself still all run (`stopImmediate`
     * would be needed to stop those), so the application is modelled as a
     * listener on the document below the window — which is exactly the position
     * the real interface occupies.
     */
    dispatch(type, event) {
      const shaped = { type, target: null, stopped: false, stopPropagation() { this.stopped = true }, preventDefault() {}, ...event }
      for (const entry of windowListeners) {
        if (entry.removed || entry.type !== type || !entry.capture) continue
        entry.fn(shaped)
      }
      // React commits after a handler returns; without this the state changes a
      // handler made would never reach the DOM, and every assertion below would
      // be reading a frame that no longer exists.
      flush()
      return { reachedApplication: !shaped.stopped, event: shaped }
    },
    activeCaptureTypes() {
      return windowListeners.filter((entry) => !entry.removed && entry.capture).map((entry) => entry.type)
    },
    liveTimers() {
      return timers.filter((entry) => !entry.cleared && !entry.fired)
    },
    armedDelays() {
      return timers.map((entry) => entry.delay)
    },
  }
}

let currentComponent = () => null
let registration

/**
 * Build a world, register the plugin into it, and return the splash component.
 *
 * The two transports are given separately on purpose: `apply` decides whether to
 * mount the overlay from a SYNCHRONOUS read (the gate), while the component reads
 * its own settings asynchronously. They are two reads of the same file at two
 * moments, and the Host's cover is injected on the gate's verdict — so a scenario
 * where they disagree is a real one, not a contrivance.
 * @param wire - what the component's `fetch` answers with.
 * @param gateWire - what the synchronous gate reads; defaults to the same payload.
 */
async function mountSplash(wire, gateWire = wire) {
  const world = createWorld()

  globalThis.window = world.window
  globalThis.document = world.document
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => wire })
  globalThis.XMLHttpRequest = class {
    open() {}
    send() {
      this.status = 200
      this.responseText = JSON.stringify(gateWire)
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

  // A fresh module instance per world, so the registration is never shared.
  await import(`${pathToFileURL(CLIENT_PATH).href}?world=${Date.now()}-${Math.random()}`)
  const captured = world.registration
  if (captured === undefined) throw new Error('client.js did not register through window.__ModuleLoader__.load')

  let component
  const face = captured.factory((specifier) => {
    if (specifier === 'react') return world.React
    if (specifier === 'react-dom') {
      return {
        createPortal: (node, target) => {
          world.portals.push(target)
          return node
        },
      }
    }
    throw new Error(`the browser half required an undeclared module: ${specifier}`)
  })
  face.apply({
    slots: {
      inject(slot, run) {
        run()
      },
      register(options, registered) {
        if (options.name === 'shell.overlay') component = registered
      },
    },
  })
  if (typeof component !== 'function') throw new Error('the overlay component was not registered for a configured video')

  world.setComponent(component)
  world.mount()
  return world
}

/** The settings a splash is normally driven with. */
const SETTINGS = { skip: 'click', fadeOutMs: 300, fadeInMs: 320, muted: true, volume: 0.6, playbackRate: 1, fit: 'cover', background: '#000000', duration: 0, holdAfterEndMs: 0, tailDissolve: false, maxReplays: 0, waitForAppMs: 2500, skipAfterMs: 1200, random: false, folder: '', selected: [], startMaximized: false }

/**
 * Let the component's own `fetch` reply land.
 *
 * The settings arrive on a promise, so the first render is always the loading
 * cover. This uses the REAL `setTimeout` — the stubbed one belongs to the window
 * under test and must not be driven by accident.
 */
const settle = () => new Promise((done) => setTimeout(done, 0))

/** Mount a splash and wait for its settings, so the scenarios start from 'ready'. */
async function mountReady(wire, gateWire = wire) {
  const world = await mountSplash(wire, gateWire)
  await settle()
  world.flush()
  return world
}

/** A still image: it never dismisses itself, so the dismissal under test is ours. */
const IMAGE_MEDIA = { kind: 'image', url: '/dsh-splash-animation/asset/a.png', name: 'a.png', mime: 'image/png', extension: 'png', bytes: 2048 }
/** Unplayable media: the component dismisses immediately, without any user input. */
const NONE_MEDIA = { kind: 'none' }

/**
 * Walk a mounted splash through a dismissal and assert the terminal state.
 *
 * The assertions are the same for every scenario, because the guarantee is the
 * same: once the splash has been dismissed, the overlay is gone and the
 * application gets its input back. How the dismissal started is the only thing
 * that varies.
 * @param world - the mounted world.
 * @param drive - performs the scenario's dismissal.
 */
function assertDismisses(world, drive) {
  // While the splash owns the screen it must be capturing input on purpose —
  // that part is by design, and asserting it keeps this suite honest about what
  // "the fix" is: the splash may hold input, it may not KEEP it.
  const before = world.activeCaptureTypes()
  check(before.includes('pointerdown') && before.includes('click'), 'the splash captures input while it owns the screen', JSON.stringify(before))

  const blocked = world.dispatch('click', { target: null })
  check(!blocked.reachedApplication, 'and the application sees nothing while it does', String(blocked.reachedApplication))

  drive(world)

  // The dissolve itself: still mounted, now transparent.
  const fading = world.output
  const fadingStyle = fading !== null && fading !== undefined ? fading.props?.style : undefined
  check(
    fading !== null && fading !== undefined && fadingStyle?.opacity === 0,
    'a dismissed splash fades rather than vanishing, matching the dissolve',
    JSON.stringify(fadingStyle),
  )

  // The terminal state. This is the assertion 0.8.1 failed.
  world.advance(SETTINGS.fadeOutMs)
  check(world.output === null, 'the overlay unmounts once the dissolve has run', JSON.stringify(world.output)?.slice(0, 80))

  const after = world.activeCaptureTypes()
  check(after.length === 0, 'the window-level capture listeners are released', JSON.stringify(after))

  const delivered = world.dispatch('click', { target: null })
  check(delivered.reachedApplication, 'and a click reaches the application again — the interface is usable', String(delivered.reachedApplication))

  const live = world.liveTimers()
  check(live.length === 0, 'no timer is left pending once the splash is gone', JSON.stringify(live.map((entry) => entry.delay)))
}

console.log(`\ndismissal lifecycle — ${CLIENT_PATH}`)

// ── the reported incident: the user clicks to skip ───────────────────────
{
  const world = await mountReady({ version: 3, settings: { ...SETTINGS }, media: IMAGE_MEDIA, problem: null })
  const skip = findSkipNode(world.output)
  check(skip !== undefined, 'the mounted splash carries the skip affordance the Host looks for', String(skip !== undefined))
  const overlay = findOverlayNode(world.output)
  const overlayStyle = overlay?.props?.style
  check(
    overlayStyle?.position === 'fixed' && overlayStyle?.pointerEvents === 'auto' && overlayStyle?.inset === 0,
    'and it is the full-viewport input-owning layer described in the incident',
    JSON.stringify(overlayStyle),
  )

  const armedBefore = world.armedDelays().length
  assertDismisses(world, (self) => {
    const fired = self.dispatch('click', { target: { closest: () => null } })
    check(fired.event.stopped === true, 'the dismissing click is consumed by the splash, as designed')
  })
  const armedByDismissal = world.armedDelays().length - armedBefore
  check(armedByDismissal >= 1, 'dismissing arms a fade timer at all', String(armedByDismissal))
  if (process.env.TRACE === '1') console.log('  trace:', world.trace.join(' | '))

  const fadeDelays = world.armedDelays().filter((delay) => delay === SETTINGS.fadeOutMs)
  check(fadeDelays.length === 1, 'exactly one fade timer is armed per dismissal — no pointless second one', JSON.stringify(world.armedDelays()))
}

// ── Escape, the keyboard path ────────────────────────────────────────────
{
  const world = await mountReady({ version: 3, settings: { ...SETTINGS, skip: 'button' }, media: IMAGE_MEDIA, problem: null })
  assertDismisses(world, (self) => {
    for (const entry of self.windowListeners) {
      if (!entry.removed && entry.type === 'keydown') {
        entry.fn({ key: 'Escape', preventDefault() {} })
        break
      }
    }
    self.flush()
  })
}

// ── the two reads disagree: the gate mounted it, the settings say unplayable ──
{
  const world = await mountReady(
    { version: 3, settings: { ...SETTINGS }, media: NONE_MEDIA, problem: null },
    { version: 3, settings: { ...SETTINGS }, media: IMAGE_MEDIA, problem: null },
  )
  assertDismisses(world, () => {})
}

// ── dismissal twice must stay a no-op ────────────────────────────────────
{
  const world = await mountReady({ version: 3, settings: { ...SETTINGS }, media: IMAGE_MEDIA, problem: null })
  world.dispatch('click', { target: { closest: () => null } })
  world.dispatch('click', { target: { closest: () => null } })
  world.flush()
  const fadeDelays = world.armedDelays().filter((delay) => delay === SETTINGS.fadeOutMs)
  check(fadeDelays.length === 1, 'a second dismissal does not arm a second timer', JSON.stringify(world.armedDelays()))
  world.advance(SETTINGS.fadeOutMs)
  check(world.output === null, 'and the splash still unmounts', JSON.stringify(world.output)?.slice(0, 80))
}

/** Find the node the Host marks as the skip affordance, anywhere in the tree. */
function findSkipNode(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSkipNode(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.props !== undefined && node.props['data-dsh-splash-skip'] !== undefined) return node
  return findSkipNode(node.children)
}

/**
 * Find the overlay itself: the node that covers the viewport and owns input.
 *
 * It is not the skip hint — in `click` mode that hint is deliberately
 * `pointer-events: none` so it cannot swallow the very click meant to skip, and
 * the marker it carries is what the window-level listener hit-tests against.
 * The layer that starves the application is this one.
 */
function findOverlayNode(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOverlayNode(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.props !== undefined && node.props['data-dsh-splash-animation'] !== undefined) return node
  return findOverlayNode(node.children)
}

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((result) => !result.ok)
for (const result of results) {
  if (!result.ok) console.log(`  FAIL  ${result.label}${result.detail === undefined ? '' : `  [${result.detail}]`}`)
}
if (failed.length === 0) {
  console.log(`PASS — ${results.length}/${results.length} assertions`)
  process.exit(0)
}
console.log(`FAIL — ${results.length - failed.length}/${results.length} assertions held`)
process.exit(1)
