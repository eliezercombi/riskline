// Paper venue. Fills at the last traded price it has been told about, keeps
// stops and targets itself and triggers them from the tick stream. No leverage,
// no shorting: it mirrors what a spot account can do.

import type { Account, Broker, Fill, Position, SymbolRules } from './types.ts'
import { DEFAULT_RULES, roundDown, roundTo } from './types.ts'

export interface PaperState {
  cash: number
  positions: Position[]
  realized: number
  fills: Fill[]
  seq: number
}

export const freshPaperState = (cash = 10_000): PaperState => ({ cash, positions: [], realized: 0, fills: [], seq: 0 })

export class PaperBroker implements Broker {
  state: PaperState
  prices = new Map<string, number>()
  rules = new Map<string, SymbolRules>()
  /** Proportional cost per fill, e.g. 0.001 for 10 bps. */
  feeRate: number
  onFill: (fill: Fill) => void = () => {}
  onChange: (state: PaperState) => void = () => {}
  now: () => number

  constructor(state: PaperState = freshPaperState(), options: { feeRate?: number; now?: () => number } = {}) {
    this.state = state
    this.feeRate = options.feeRate ?? 0.001
    this.now = options.now ?? Date.now
  }

  setRules(rules: SymbolRules): void {
    this.rules.set(rules.symbol, rules)
  }

  rulesFor(symbol: string): SymbolRules {
    return this.rules.get(symbol) ?? DEFAULT_RULES(symbol)
  }

  private last(symbol: string): number {
    const value = this.prices.get(symbol)
    if (!(value && value > 0)) throw new Error(`No price for ${symbol} yet`)
    return value
  }

  private find(symbol: string): Position | undefined {
    return this.state.positions.find((p) => p.symbol === symbol)
  }

  private record(fill: Omit<Fill, 'id' | 'time'>): Fill {
    const done: Fill = { ...fill, id: `p${++this.state.seq}`, time: this.now() }
    this.state.fills.push(done)
    if (this.state.fills.length > 200) this.state.fills.shift()
    this.onFill(done)
    this.onChange(this.state)
    return done
  }

  async account(): Promise<Account> {
    return { mode: 'paper', cash: this.state.cash, positions: this.state.positions.map((p) => ({ ...p })), realized: this.state.realized }
  }

  async buy(symbol: string, quoteAmount: number): Promise<Fill> {
    const rules = this.rulesFor(symbol)
    const px = this.last(symbol)
    if (!(quoteAmount >= rules.minNotional)) throw new Error(`Order is below the ${rules.minNotional} ${rules.quote} minimum`)
    const cost = quoteAmount * (1 + this.feeRate)
    if (cost > this.state.cash + 1e-9) throw new Error(`Not enough ${rules.quote}: ${this.state.cash.toFixed(2)} free`)

    const size = roundDown(quoteAmount / px, rules.step)
    if (!(size > 0)) throw new Error('Order size rounds to zero')
    const spent = size * px
    this.state.cash -= spent * (1 + this.feeRate)

    const held = this.find(symbol)
    if (held) {
      held.entry = (held.entry * held.qty + spent) / (held.qty + size)
      held.qty = roundTo(held.qty + size, rules.step)
    } else {
      this.state.positions.push({ symbol, qty: size, entry: px, openedAt: this.now() })
    }
    return this.record({ symbol, side: 'buy', qty: size, price: px, reason: 'manual' })
  }

  async sell(symbol: string, fraction: number, reason: Fill['reason'] = 'manual', at?: number): Promise<Fill> {
    const held = this.find(symbol)
    if (!held) throw new Error(`No ${symbol} position`)
    const rules = this.rulesFor(symbol)
    const px = at ?? this.last(symbol)
    const part = Math.min(1, Math.max(0, fraction))
    const size = part >= 1 ? held.qty : roundDown(held.qty * part, rules.step)
    if (!(size > 0)) throw new Error('Nothing to sell at that size')

    const proceeds = size * px
    const pnl = (px - held.entry) * size - proceeds * this.feeRate
    this.state.cash += proceeds * (1 - this.feeRate)
    this.state.realized += pnl
    held.qty = roundTo(held.qty - size, rules.step)
    if (held.qty <= rules.step / 2) this.state.positions = this.state.positions.filter((p) => p !== held)
    return this.record({ symbol, side: 'sell', qty: size, price: px, pnl, reason })
  }

  async protect(symbol: string, levels: { stop?: number | null; target?: number | null }): Promise<Position> {
    const held = this.find(symbol)
    if (!held) throw new Error(`No ${symbol} position`)
    const rules = this.rulesFor(symbol)
    const px = this.last(symbol)

    if (levels.stop !== undefined) {
      if (levels.stop === null) held.stop = undefined
      else {
        const stop = roundTo(levels.stop, rules.tick)
        if (!(stop < px)) throw new Error('A stop has to sit below the current price')
        // 1R is fixed by the first stop, so moving the stop later does not rewrite history.
        if (held.riskPerUnit === undefined && stop < held.entry) held.riskPerUnit = held.entry - stop
        held.stop = stop
      }
    }
    if (levels.target !== undefined) {
      if (levels.target === null) held.target = undefined
      else {
        const target = roundTo(levels.target, rules.tick)
        if (!(target > px)) throw new Error('A target has to sit above the current price')
        held.target = target
      }
    }
    this.onChange(this.state)
    return { ...held }
  }

  async flatten(): Promise<Fill[]> {
    const fills: Fill[] = []
    for (const position of [...this.state.positions]) fills.push(await this.sell(position.symbol, 1))
    return fills
  }

  /** Feed a trade price. Returns the fills it triggered (stop or target). */
  async tick(symbol: string, px: number): Promise<Fill[]> {
    this.prices.set(symbol, px)
    const held = this.find(symbol)
    if (!held) return []
    if (held.stop !== undefined && px <= held.stop) return [await this.sell(symbol, 1, 'stop', px)]
    if (held.target !== undefined && px >= held.target) return [await this.sell(symbol, 1, 'target', px)]
    return []
  }
}
