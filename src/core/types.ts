// Shared shapes. Spot, long-only: a "position" is base asset bought during the
// session, with an average entry and optional protective stop and target.

export interface Tick {
  symbol: string
  price: number
  /** Price 24 hours ago, for the daily change. */
  open24h: number
  time: number
}

export interface Position {
  symbol: string
  qty: number
  /** Volume-weighted average entry price. */
  entry: number
  stop?: number
  target?: number
  /** Stop distance at the moment the stop was first placed, in quote currency per unit. Defines 1R. */
  riskPerUnit?: number
  openedAt: number
}

export interface Fill {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  /** Realised P&L of a sell, in quote currency. */
  pnl?: number
  reason: 'manual' | 'stop' | 'target'
  time: number
}

export interface Account {
  mode: 'paper' | 'testnet'
  /** Free quote currency (USDT). */
  cash: number
  positions: Position[]
  /** Realised P&L since the session started. */
  realized: number
}

/** What every execution venue has to do for the app. Prices are passed in so the paper venue stays pure. */
export interface Broker {
  account(): Promise<Account>
  buy(symbol: string, quoteAmount: number): Promise<Fill>
  sell(symbol: string, fraction: number, reason?: Fill['reason']): Promise<Fill>
  protect(symbol: string, levels: { stop?: number | null; target?: number | null }): Promise<Position>
  /** Sell everything at market and drop all protective orders. */
  flatten(): Promise<Fill[]>
}

export interface SymbolRules {
  symbol: string
  base: string
  quote: string
  /** Smallest price increment. */
  tick: number
  /** Smallest quantity increment. */
  step: number
  /** Smallest order value in quote currency. */
  minNotional: number
}

export const DEFAULT_RULES = (symbol: string): SymbolRules => ({
  symbol,
  base: symbol.replace(/USDT$|USDC$|FDUSD$/, ''),
  quote: symbol.match(/USDT$|USDC$|FDUSD$/)?.[0] ?? 'USDT',
  tick: 0.01,
  step: 0.00001,
  minNotional: 5,
})

export const roundDown = (value: number, increment: number): number => {
  if (!(increment > 0)) return value
  const scaled = Math.floor(value / increment + 1e-9) * increment
  return Number(scaled.toFixed(Math.max(0, -Math.floor(Math.log10(increment)))))
}

export const roundTo = (value: number, increment: number): number => {
  if (!(increment > 0)) return value
  const scaled = Math.round(value / increment) * increment
  return Number(scaled.toFixed(Math.max(0, -Math.floor(Math.log10(increment)))))
}
