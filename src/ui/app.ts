// The controller: owns what is on screen and what each gesture does.
// It knows nothing about the SDK. Input arrives as plain values and every
// state change ends in `deps.render(page)`.

import * as f from '../core/format.ts'
import type { Measure } from '../core/format.ts'
import { actionsFor, suggest } from '../core/actions.ts'
import type { Action, Settings } from '../core/actions.ts'
import { proximity } from '../core/alerts.ts'
import type { Alerts } from '../core/alerts.ts'
import { order, viewOf } from '../core/session.ts'
import { HINT, parseCommand } from '../core/voice.ts'
import type { View } from '../core/session.ts'
import type { Account, Broker, Fill, SymbolRules, Tick } from '../core/types.ts'
import { roundTo } from '../core/types.ts'
import { MENU_ALERTS, MENU_FLATTEN, actionsPage, cardPage, confirmPage, emptyPage, listeningPage, resultPage, sessionPage } from './pages.ts'
import type { Card, Chrome, Page } from './pages.ts'

export type Input = 'tap' | 'double' | 'up' | 'down' | 'hold' | 'release' | { select: number } | { menu: number }

/** Push-to-talk, provided by the host: start capturing on hold, return the transcript on release. */
export interface Voice {
  available: () => boolean
  start: () => void
  stop: () => Promise<string>
  cancel: () => void
}

interface Queued {
  card: Card
  symbol: string
  /** Risk-reducing action a tap runs straight away. */
  actionId?: string
  /** Without an action: does a tap open the action list, or only dismiss? */
  opensActions: boolean
}

type Screen =
  | { kind: 'session' }
  | { kind: 'actions'; symbol: string; ids: string[] }
  | { kind: 'confirm'; symbol: string; actionId: string; lines: string[] }
  | { kind: 'custom'; lines: string[]; run: () => Promise<string> }
  | { kind: 'listening' }
  | { kind: 'flatten' }
  | { kind: 'result'; ok: boolean; lines: string[]; token: number }
  | { kind: 'card'; item: Queued }

export interface Deps {
  broker: Broker
  alerts: Alerts
  settings: Settings
  measure: Measure
  rulesFor: (symbol: string) => SymbolRules
  render: (page: Page) => void
  /** Show the system exit dialog. */
  exit: () => void
  now?: () => number
  later?: (fn: () => void, ms: number) => void
  /** Called after anything worth saving changed (alerts, pause flag). */
  changed?: () => void
  voice?: Voice
}

type Ticking = Broker & { tick?: (symbol: string, price: number) => Promise<Fill[]> }

export class App {
  watch: string[]
  ticks = new Map<string, Tick>()
  history = new Map<string, number[]>()
  account: Account = { mode: 'paper', cash: 0, positions: [], realized: 0 }
  selected: string
  note = 'Ready.'
  screen: Screen = { kind: 'session' }
  queue: Queued[] = []
  alertsPaused = false
  busy = false
  private near = new Set<string>()
  private token = 0
  private deps: Deps
  private now: () => number
  private later: (fn: () => void, ms: number) => void

  constructor(watch: string[], deps: Deps) {
    this.watch = watch
    this.selected = watch[0] ?? ''
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.later = deps.later ?? ((fn, ms) => void setTimeout(fn, ms))
  }

  /* ---------- derived state ---------- */

  views(): View[] {
    const symbols = [...new Set([...this.watch, ...this.account.positions.map((p) => p.symbol)])]
    return order(symbols.map((symbol) =>
      viewOf(this.deps.rulesFor(symbol), this.ticks.get(symbol), this.account.positions.find((p) => p.symbol === symbol), this.history.get(symbol), this.now())))
  }

  view(symbol = this.selected): View | undefined {
    return this.views().find((v) => v.symbol === symbol)
  }

  private actions(view: View): Action[] {
    return actionsFor(view, { broker: this.deps.broker, alerts: this.deps.alerts, rules: this.deps.rulesFor(view.symbol), settings: this.deps.settings, cash: this.account.cash })
  }

  private chrome(): Chrome {
    return { mode: this.account.mode, alertsPaused: this.alertsPaused, anyPosition: this.account.positions.length > 0 }
  }

  page(): Page {
    const chrome = this.chrome()
    const views = this.views()
    const screen = this.screen
    switch (screen.kind) {
      case 'actions': {
        const view = views.find((v) => v.symbol === screen.symbol)
        if (!view) break
        const byId = new Map(this.actions(view).map((a) => [a.id, a]))
        return actionsPage(view, screen.ids.map((id) => byId.get(id)?.label ?? '(no longer available)'), chrome)
      }
      case 'confirm':
      case 'custom':
        return confirmPage(screen.lines, chrome)
      case 'listening':
        return listeningPage(HINT, chrome)
      case 'flatten': {
        const total = views.filter((v) => v.held).reduce((sum, v) => sum + v.pnl, 0)
        return confirmPage(['Flatten everything?', `Sell ${this.account.positions.length} position(s) at market`, `Open result ${f.signed(total)} USDT`], chrome)
      }
      case 'result':
        return resultPage(screen.ok, screen.lines, chrome)
      case 'card':
        return cardPage(screen.item.card, this.queue.length, chrome, this.deps.measure)
      default:
        break
    }
    const index = Math.max(0, views.findIndex((v) => v.symbol === this.selected))
    const view = views[index]
    if (!view) return emptyPage('No symbols yet.\nAdd some on your phone.', chrome)
    return sessionPage(view, index, views.length, this.note, this.deps.alerts.for(view.symbol), chrome, this.deps.measure)
  }

  render(): void {
    this.deps.render(this.page())
  }

  /* ---------- data in ---------- */

  async refresh(): Promise<void> {
    this.account = await this.deps.broker.account()
  }

  /** Feed one price update: triggers paper stops, alerts and proximity warnings, then redraws. */
  async tick(tick: Tick): Promise<void> {
    this.ticks.set(tick.symbol, tick)
    const broker = this.deps.broker as Ticking
    if (broker.tick) {
      const fills = await broker.tick(tick.symbol, tick.price)
      if (fills.length) {
        await this.refresh()
        for (const fill of fills) this.announceFill(fill)
      }
    }
    if (!this.alertsPaused) {
      for (const hit of this.deps.alerts.check(tick.symbol, tick.price, this.now())) {
        this.deps.changed?.()
        this.announce(tick.symbol, hit.rule.kind, {
          tag: `ALERT   ${tick.symbol}`,
          title: `Crossed ${hit.rule.kind} ${f.price(hit.rule.level)}`,
        })
      }
      const view = this.view(tick.symbol)
      const kind = view ? proximity(view, this.near) : null
      if (view && kind) {
        this.announce(tick.symbol, kind, {
          tag: `${kind === 'stop-near' ? 'NEAR STOP' : 'NEAR TARGET'}   ${tick.symbol}`,
          title: kind === 'stop-near' ? `${f.pct(view.toStop ?? 0)} to the stop at ${f.price(view.stop ?? 0)}` : `${f.pct(view.toTarget ?? 0)} to the target at ${f.price(view.target ?? 0)}`,
        })
      }
    }
    this.render()
  }

  /** Fills that came from outside a tap (a stop or target on the venue). */
  announceFill(fill: Fill): void {
    if (fill.reason === 'manual') return
    const stopped = fill.reason === 'stop'
    this.note = `${stopped ? 'Stopped out' : 'Target hit'}: ${fill.symbol} ${f.signed(fill.pnl ?? 0)}`
    this.push({
      symbol: fill.symbol,
      opensActions: false,
      card: {
        tag: `${stopped ? 'STOPPED OUT' : 'TARGET HIT'}   ${fill.symbol}`,
        title: `Sold ${f.qty(fill.qty)} at ${f.price(fill.price)}`,
        body: [`Result ${f.signed(fill.pnl ?? 0)} USDT`, `Session ${f.signed(this.account.realized)} USDT`],
        offer: 'dismiss',
      },
    })
  }

  private announce(symbol: string, reason: 'above' | 'below' | 'stop-near' | 'target-near', head: { tag: string; title: string }): void {
    const view = this.view(symbol)
    if (!view) return
    const offer = suggest(view, reason, this.actions(view))
    const body = [`Now ${f.price(view.price)}   ${f.arrow(view.change24h)} ${f.pct(view.change24h)} 24h`]
    if (view.held) body.push(`P&L ${f.signed(view.pnl)} ${view.quote}${view.r !== undefined ? `   ${f.rMultiple(view.r)}` : ''}`)
    this.push({ symbol, actionId: offer?.id, opensActions: true, card: { ...head, body, offer: offer ? lower(offer.label) : '' } })
  }

  private push(item: Queued): void {
    // Never interrupt a decision in progress; the card waits its turn.
    if (this.screen.kind === 'session' || this.screen.kind === 'result') this.screen = { kind: 'card', item }
    else this.queue.push(item)
  }

  /* ---------- gestures ---------- */

  async input(input: Input): Promise<void> {
    if (this.busy) return
    if (typeof input === 'object' && 'menu' in input) return this.menu(input.menu)

    const screen = this.screen
    switch (screen.kind) {
      case 'session':
        if (input === 'double') return this.deps.exit()
        if (input === 'down' || input === 'up') this.step(input === 'down' ? 1 : -1)
        else if (input === 'tap') this.openActions(this.selected)
        else if (input === 'hold') {
          if (!this.deps.voice?.available()) return this.finish(false, ['Voice is not set up yet.', 'Add a speech service on your phone,', 'or type a command there.'])
          this.deps.voice.start()
          this.screen = { kind: 'listening' }
        }
        break

      case 'listening':
        if (input === 'release') return this.heard()
        if (input === 'double') {
          this.deps.voice?.cancel()
          this.screen = { kind: 'session' }
        }
        break

      case 'custom':
        if (input === 'tap') return this.guarded(screen.run)
        if (input === 'double') this.screen = { kind: 'session' }
        break

      case 'actions':
        if (input === 'double') this.screen = { kind: 'session' }
        else if (typeof input === 'object' && 'select' in input) {
          const id = screen.ids[input.select]
          const action = id && this.resolve(screen.symbol, id)
          this.screen = action ? { kind: 'confirm', symbol: screen.symbol, actionId: action.id, lines: action.confirm } : { kind: 'session' }
        }
        break

      case 'confirm':
        if (input === 'tap') return this.execute(screen.symbol, screen.actionId)
        if (input === 'double') this.screen = { kind: 'session' }
        break

      case 'flatten':
        if (input === 'tap') {
          return this.guarded(async () => {
            const fills = await this.deps.broker.flatten()
            const total = fills.reduce((sum, fill) => sum + (fill.pnl ?? 0), 0)
            return `Flat. ${fills.length} position(s) closed, ${f.signed(total)} USDT`
          })
        }
        if (input === 'double') this.screen = { kind: 'session' }
        break

      case 'result':
        this.next()
        break

      case 'card':
        if (input === 'tap' && screen.item.actionId) return this.execute(screen.item.symbol, screen.item.actionId)
        if (input === 'tap' && screen.item.opensActions) {
          this.selected = screen.item.symbol
          this.openActions(screen.item.symbol)
        } else this.next()
        break
    }
    this.render()
  }

  private async heard(): Promise<void> {
    this.busy = true
    let text = ''
    try {
      text = await (this.deps.voice as Voice).stop()
    } catch (error) {
      this.busy = false
      return this.finish(false, [error instanceof Error ? error.message : String(error), 'Nothing was sent.'])
    }
    this.busy = false
    return this.command(text)
  }

  /**
   * Run a spoken or typed command. It never sends an order: at most it opens
   * the same confirmation screen a tap would, and the user still has to tap.
   */
  async command(spoken: string): Promise<void> {
    if (this.busy) return
    const text = spoken.trim()
    const views = this.views()
    const parsed = parseCommand(text, { symbols: views.map((v) => v.symbol), sizes: this.deps.settings.sizes })
    if (!parsed) return this.finish(false, [text ? `Heard "${text}"` : 'Heard nothing.', 'Try: sell half, close, buy 500,', 'stop to break-even, alert 62000'])
    this.note = `Heard "${text}"`

    if (parsed.kind === 'select') this.selected = parsed.symbol
    if (parsed.kind === 'select' || parsed.kind === 'alerts') {
      if (parsed.kind === 'alerts' && parsed.paused !== this.alertsPaused) await this.menu(MENU_ALERTS)
      this.screen = { kind: 'session' }
      return this.render()
    }
    if (parsed.kind === 'flatten') {
      if (!this.account.positions.length) return this.finish(false, ['Nothing to flatten.', 'There are no open positions.'])
      this.screen = { kind: 'flatten' }
      return this.render()
    }

    const view = this.view()
    if (!view || view.stale) return this.finish(false, ['Waiting for a price.', 'Nothing was sent.'])

    if (parsed.kind === 'alert') {
      const rules = this.deps.rulesFor(view.symbol)
      const level = roundTo(parsed.level, rules.tick)
      const kind = parsed.side === 'cross' ? (level > view.price ? 'above' : 'below') : parsed.side
      if ((kind === 'above') !== (level > view.price)) return this.finish(false, [`${view.base} is already ${kind} ${f.price(level)}.`, 'No alert was set.'])
      this.screen = {
        kind: 'custom',
        lines: ['Set an alert?', `${view.base} ${kind} ${f.price(level)}`, `${f.pct(level / view.price - 1)} from here. It fires once.`],
        run: async () => {
          this.deps.alerts.add(view.symbol, kind, level, this.now())
          return `Alert set: ${view.base} ${kind} ${f.price(level)}`
        },
      }
      return this.render()
    }

    const action = this.resolve(view.symbol, parsed.id)
    if (!action) return this.finish(false, [`"${text}" does not apply to ${view.base} right now.`, 'Nothing was sent.'])
    this.screen = { kind: 'confirm', symbol: view.symbol, actionId: action.id, lines: action.confirm }
    this.render()
  }

  private async menu(id: number): Promise<void> {
    if (id === MENU_FLATTEN && this.account.positions.length) this.screen = { kind: 'flatten' }
    if (id === MENU_ALERTS) {
      this.alertsPaused = !this.alertsPaused
      this.note = this.alertsPaused ? 'Alerts paused.' : 'Alerts on.'
      this.deps.changed?.()
    }
    this.render()
  }

  private step(delta: number): void {
    const views = this.views()
    if (!views.length) return
    const at = Math.max(0, views.findIndex((v) => v.symbol === this.selected))
    this.selected = views[(at + delta + views.length) % views.length].symbol
  }

  private openActions(symbol: string): void {
    const view = this.view(symbol)
    if (!view || view.stale) {
      this.note = 'Waiting for a price before acting.'
      return
    }
    this.screen = { kind: 'actions', symbol, ids: this.actions(view).map((a) => a.id) }
  }

  /** Actions are rebuilt from live data at the moment they are used, never from a stale menu. */
  private resolve(symbol: string, id: string): Action | undefined {
    const view = this.view(symbol)
    return view && !view.stale ? this.actions(view).find((a) => a.id === id) : undefined
  }

  private async execute(symbol: string, id: string): Promise<void> {
    const action = this.resolve(symbol, id)
    if (!action) return this.finish(false, ['That action is no longer available.', 'Nothing was sent.'])
    return this.guarded(action.run)
  }

  private async guarded(run: () => Promise<string>): Promise<void> {
    this.busy = true
    try {
      const line = await run()
      await this.refresh()
      this.deps.changed?.()
      this.note = line
      this.finish(true, [line])
    } catch (error) {
      this.finish(false, [error instanceof Error ? error.message : String(error), 'Nothing was changed.'])
    } finally {
      this.busy = false
    }
  }

  private finish(ok: boolean, lines: string[]): void {
    const token = ++this.token
    this.screen = { kind: 'result', ok, lines, token }
    this.render()
    // A result is a glance, not a stop: fall back to the session on its own.
    this.later(() => {
      if (this.screen.kind === 'result' && this.screen.token === token) {
        this.next()
        this.render()
      }
    }, ok ? 2500 : 5000)
  }

  private next(): void {
    const item = this.queue.shift()
    this.screen = item ? { kind: 'card', item } : { kind: 'session' }
  }
}

const lower = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
