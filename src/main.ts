// Wires everything together: bridge, display, price feed, paper venue,
// controller and the phone-side page.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'

import { mountCompanion } from './companion.ts'
import { DEFAULT_SETTINGS } from './core/actions.ts'
import type { Settings } from './core/actions.ts'
import { Alerts } from './core/alerts.ts'
import type { AlertRule } from './core/alerts.ts'
import { PaperBroker, freshPaperState } from './core/paper.ts'
import type { PaperState } from './core/paper.ts'
import { RemoteBroker } from './core/remote.ts'
import { DEFAULT_RULES } from './core/types.ts'
import type { Broker, SymbolRules } from './core/types.ts'
import { transcribe, wavFromPcm } from './core/voice.ts'
import type { SttConfig } from './core/voice.ts'
import { BinanceFeed } from './market/binance.ts'
import { App } from './ui/app.ts'
import type { Input, Voice } from './ui/app.ts'
import { Display } from './ui/display.ts'
import type { Bridge } from './ui/display.ts'
import { translate } from './ui/input.ts'
import type { HubEvent } from './ui/input.ts'
import type { Page } from './ui/pages.ts'
import './style.css'

const STORE = 'riskline.v1'
const log = (message: string): void => console.log(`[riskline] ${message}`)

interface Saved {
  watch: string[]
  settings: Settings
  paper: PaperState
  alerts: AlertRule[]
  alertsPaused: boolean
  /** Set when orders go to the testnet bridge instead of the built-in paper account. */
  bridge: { url: string; token: string } | null
  /** Speech-to-text endpoint for push-to-talk. The key is the user's own and stays on their phone. */
  stt: SttConfig | null
}

function load(): Saved {
  const fresh: Saved = { watch: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], settings: { ...DEFAULT_SETTINGS }, paper: freshPaperState(), alerts: [], alertsPaused: false, bridge: null, stt: null }
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Saved> | null
    if (!raw) return fresh
    return {
      watch: Array.isArray(raw.watch) && raw.watch.length ? raw.watch.map(String) : fresh.watch,
      settings: { ...fresh.settings, ...raw.settings },
      paper: { ...fresh.paper, ...raw.paper },
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      alertsPaused: Boolean(raw.alertsPaused),
      bridge: raw.bridge && raw.bridge.url && raw.bridge.token ? { url: String(raw.bridge.url), token: String(raw.bridge.token) } : null,
      stt: raw.stt && raw.stt.url ? { url: String(raw.stt.url), key: String(raw.stt.key ?? ''), model: String(raw.stt.model || 'whisper-1') } : null,
    }
  } catch {
    return fresh
  }
}

type Host = Bridge & {
  onEvenHubEvent: (cb: (event: HubEvent) => void) => () => void
  audioControl: (isOpen: boolean) => Promise<boolean>
}

/** Stand-in used in a plain browser tab, where no glasses host exists. */
const previewBridge: Host = {
  audioControl: async () => true,
  createStartUpPageContainer: async () => 0,
  rebuildPageContainer: async () => true,
  textContainerUpgrade: async () => true,
  shutDownPageContainer: async () => true,
  onEvenHubEvent: () => () => {},
}

async function connect(): Promise<{ bridge: Host; preview: boolean }> {
  const found = await Promise.race([
    waitForEvenAppBridge().then((bridge) => bridge as unknown as Host),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
  ])
  return found ? { bridge: found, preview: false } : { bridge: previewBridge, preview: true }
}

const saved = load()

// Optional start-up overrides for repeatable test and demo runs, e.g.
//   ?reset=1&watch=BTCUSDT,ETHUSDT&sizes=100,500&stop=0.05&target=0.1&alert=0.03   (percentages)
//   &say=sell%20half   scripted voice transcripts for automated recordings, see `scripted` below
{
  const query = new URLSearchParams(location.search)
  const percent = (name: string): number | null => {
    const value = Number(query.get(name))
    return query.has(name) && value > 0 && value < 100 ? value / 100 : null
  }
  if (query.get('reset') === '1') {
    saved.paper = freshPaperState()
    saved.alerts = []
  }
  const watchList = (query.get('watch') ?? '').toUpperCase().split(',').filter((symbol) => /^[A-Z0-9]{5,16}$/.test(symbol))
  if (watchList.length) saved.watch = watchList
  const sizes = (query.get('sizes') ?? '').split(',').map(Number).filter((n) => n >= 5)
  if (sizes.length) saved.settings.sizes = sizes.slice(0, 3)
  saved.settings.stopPct = percent('stop') ?? saved.settings.stopPct
  saved.settings.targetPct = percent('target') ?? saved.settings.targetPct
  saved.settings.trailPct = percent('trail') ?? saved.settings.trailPct
  saved.settings.alertPct = percent('alert') ?? saved.settings.alertPct
}

const rules = new Map<string, SymbolRules>()
const rulesFor = (symbol: string): SymbolRules => rules.get(symbol) ?? DEFAULT_RULES(symbol)

const { bridge, preview } = await connect()
const display = new Display(bridge, { log })
const paper = saved.bridge ? null : new PaperBroker(saved.paper)
const remote = saved.bridge ? new RemoteBroker(saved.bridge.url, saved.bridge.token) : null
const broker: Broker = paper ?? (remote as RemoteBroker)
const alerts = new Alerts(saved.alerts)

let companion: { update: (page: Page) => void } | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

// Everything worth keeping lives in localStorage, so an Android WebView that
// gets suspended and restarted picks the session up where it was.
function save(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const state: Saved = { watch: app.watch, settings: saved.settings, paper: paper?.state ?? saved.paper, alerts: alerts.rules, alertsPaused: app.alertsPaused, bridge: saved.bridge, stt: saved.stt }
    try {
      localStorage.setItem(STORE, JSON.stringify(state))
    } catch (error) {
      log(`could not save: ${String(error)}`)
    }
  }, 300)
}

// Push-to-talk: PCM frames from the glasses are collected while the touchpad is held.
const pcm: Uint8Array[] = []
let capturing = false
// For automated recordings, where nobody can speak into the simulator: each `say`
// in the address stands in for one transcript, in order. What happens after the
// transcript (parsing, confirmation, the order itself) is the real path.
const scripted = new URLSearchParams(location.search).getAll('say').map((line) => line.trim()).filter(Boolean)

const voice: Voice = {
  available: () => scripted.length > 0 || Boolean(saved.stt?.url),
  start: () => {
    pcm.length = 0
    capturing = true
    void bridge.audioControl(true).catch((error) => log(`microphone: ${String(error)}`))
  },
  stop: async () => {
    capturing = false
    await bridge.audioControl(false).catch(() => false)
    if (scripted.length) return scripted.shift() as string
    if (!pcm.length || !saved.stt) return ''
    return transcribe(wavFromPcm(pcm), saved.stt)
  },
  cancel: () => {
    capturing = false
    void bridge.audioControl(false).catch(() => false)
  },
}

const app = new App(saved.watch, {
  broker,
  voice,
  alerts,
  settings: saved.settings,
  measure: getTextWidth,
  rulesFor,
  render: (page) => {
    display.show(page)
    companion?.update(page)
  },
  exit: () => display.exit(),
  changed: save,
})
app.alertsPaused = saved.alertsPaused
if (paper) paper.onChange = save

const held = (): string[] => app.account.positions.map((p) => p.symbol)

const feed = new BinanceFeed({
  onTick: (tick) => void app.tick(tick).catch((error) => log(`tick failed: ${String(error)}`)),
  onStatus: (status) => {
    log(`prices: ${status}`)
    app.render()
  },
})

async function watch(symbols: string[]): Promise<void> {
  app.watch = symbols
  if (!symbols.includes(app.selected)) app.selected = symbols[0] ?? ''
  save()
  const wanted = [...new Set([...symbols, ...held()])]
  feed.start(wanted)
  try {
    for (const rule of await feed.rules(wanted)) {
      rules.set(rule.symbol, rule)
      paper?.setRules(rule)
    }
  } catch (error) {
    log(`could not load exchange rules, using defaults: ${String(error)}`)
  }
  await refreshHistory()
  app.render()
}

async function refreshHistory(): Promise<void> {
  await Promise.all([...new Set([...app.watch, ...held()])].map(async (symbol) => {
    try {
      app.history.set(symbol, await feed.history(symbol))
    } catch { /* the sparkline is optional */ }
  }))
}

const handle = (input: Input): void => void app.input(input).catch((error) => log(`input failed: ${String(error)}`))

bridge.onEvenHubEvent((event) => {
  const audio = (event.audioEvent as { audioPcm?: ArrayLike<number> } | undefined)?.audioPcm
  if (audio) {
    if (capturing) pcm.push(Uint8Array.from(audio))
    return
  }
  const what = translate(event)
  if (what === null) return
  if (what === 'foreground') return app.render()
  if (what === 'background') return save()
  if (what === 'exit') {
    save()
    feed.stop()
    return
  }
  handle(what)
})

companion = mountCompanion(document.getElementById('app') as HTMLElement, {
  app,
  alerts,
  settings: saved.settings,
  preview,
  feedStatus: () => feed.status,
  stats: () => display.stats,
  setWatch: (symbols) => void watch(symbols),
  saveSettings: () => {
    save()
    app.render()
  },
  resetPaper: () => {
    if (!paper) return
    paper.state = freshPaperState()
    alerts.rules = []
    save()
    void app.refresh().then(() => app.render())
  },
  stt: () => saved.stt,
  setStt: (next) => {
    saved.stt = next
    save()
  },
  command: (text) => void app.command(text).catch((error) => log(`command failed: ${String(error)}`)),
  bridge: () => saved.bridge,
  setBridge: (next) => {
    saved.bridge = next
    save()
    // The venue is chosen at start-up, so switching it restarts the page.
    setTimeout(() => location.reload(), 400)
  },
  input: handle,
})

try {
  await app.refresh()
} catch (error) {
  app.note = error instanceof Error ? error.message : String(error)
}
app.render()
await watch(saved.watch)

if (remote) {
  // Stops and targets fill on the exchange, not in the app: ask the bridge what happened.
  setInterval(async () => {
    try {
      const fills = await remote.poll()
      await app.refresh()
      for (const fill of fills) app.announceFill(fill)
      app.render()
    } catch (error) {
      app.note = error instanceof Error ? error.message : String(error)
    }
  }, 2500)
}
setInterval(() => void refreshHistory(), 10 * 60 * 1000)
// Redraw on a slow clock too, so "waiting for prices" appears when the feed goes quiet.
setInterval(() => app.render(), 5000)
log(`ready (${preview ? 'browser preview' : 'glasses bridge'}${scripted.length ? `, ${scripted.length} scripted transcripts` : ''})`)
