// Live market data from Binance's public endpoints. No account and no API key:
// a combined mini-ticker WebSocket stream for prices, REST for the 24h history
// and the exchange's price and quantity increments.

import type { SymbolRules, Tick } from '../core/types.ts'
import { DEFAULT_RULES } from '../core/types.ts'

export const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com']
export const STREAM_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443']

/* ---------- pure parsers ---------- */

/** One message of a combined `<symbol>@miniTicker` stream. */
export function parseMiniTicker(message: unknown, now = Date.now()): Tick | null {
  const data = (message as { data?: Record<string, unknown> })?.data ?? (message as Record<string, unknown>)
  if (!data || data.e !== '24hrMiniTicker') return null
  const price = Number(data.c)
  const open24h = Number(data.o)
  if (!(price > 0) || typeof data.s !== 'string') return null
  return { symbol: data.s, price, open24h: open24h > 0 ? open24h : price, time: Number(data.E) || now }
}

/** `/api/v3/ticker/24hr` entries, used when the socket is unavailable. */
export function parseTickers(payload: unknown, now = Date.now()): Tick[] {
  const rows = Array.isArray(payload) ? payload : [payload]
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>
    const price = Number(r?.lastPrice)
    const open24h = Number(r?.openPrice)
    return price > 0 && typeof r.symbol === 'string' ? [{ symbol: r.symbol, price, open24h: open24h > 0 ? open24h : price, time: now }] : []
  })
}

/** Closing prices of `/api/v3/klines`, oldest first. */
export function parseKlines(payload: unknown): number[] {
  if (!Array.isArray(payload)) return []
  return payload.map((row) => Number((row as unknown[])[4])).filter((value) => value > 0)
}

export function parseExchangeInfo(payload: unknown): SymbolRules[] {
  const symbols = (payload as { symbols?: unknown[] })?.symbols
  if (!Array.isArray(symbols)) return []
  return symbols.map((entry) => {
    const s = entry as { symbol: string; baseAsset: string; quoteAsset: string; filters?: Record<string, string>[] }
    const filter = (type: string) => s.filters?.find((f) => f.filterType === type)
    const fallback = DEFAULT_RULES(s.symbol)
    return {
      symbol: s.symbol,
      base: s.baseAsset ?? fallback.base,
      quote: s.quoteAsset ?? fallback.quote,
      tick: Number(filter('PRICE_FILTER')?.tickSize) || fallback.tick,
      step: Number(filter('LOT_SIZE')?.stepSize) || fallback.step,
      minNotional: Number(filter('NOTIONAL')?.minNotional ?? filter('MIN_NOTIONAL')?.minNotional) || fallback.minNotional,
    }
  })
}

export const streamUrl = (host: string, symbols: string[]): string =>
  `${host}/stream?streams=${symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/')}`

/* ---------- the feed ---------- */

export type FeedStatus = 'connecting' | 'live' | 'polling' | 'offline'

export interface FeedOptions {
  onTick: (tick: Tick) => void
  onStatus?: (status: FeedStatus) => void
  restHosts?: string[]
  streamHosts?: string[]
  fetch?: typeof fetch
  WebSocket?: typeof WebSocket
}

export class BinanceFeed {
  private options: FeedOptions
  private symbols: string[] = []
  private socket: WebSocket | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = true
  private lastMessage = 0
  status: FeedStatus = 'offline'

  constructor(options: FeedOptions) {
    this.options = options
  }

  private get rest(): string[] { return this.options.restHosts ?? REST_HOSTS }
  private get streams(): string[] { return this.options.streamHosts ?? STREAM_HOSTS }
  private get fetcher(): typeof fetch { return this.options.fetch ?? fetch.bind(globalThis) }

  private set(status: FeedStatus): void {
    if (status === this.status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  /** GET a public REST path, trying each host in turn. */
  private async get(path: string): Promise<unknown> {
    let failure: unknown
    for (const host of this.rest) {
      try {
        const response = await this.fetcher(`${host}${path}`)
        if (response.ok) return await response.json()
        failure = new Error(`${host} answered ${response.status}`)
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  async rules(symbols: string[]): Promise<SymbolRules[]> {
    return parseExchangeInfo(await this.get(`/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`))
  }

  /** Hourly closes of the last day. */
  async history(symbol: string): Promise<number[]> {
    return parseKlines(await this.get(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`))
  }

  start(symbols: string[]): void {
    this.stop()
    this.stopped = false
    this.symbols = [...new Set(symbols)]
    if (!this.symbols.length) return
    this.attempt = 0
    this.connect()
    // The stream is the source of truth; polling covers gaps and blocked sockets.
    this.poller = setInterval(() => {
      if (Date.now() - this.lastMessage > 6000) void this.poll()
    }, 3000)
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.poller) clearInterval(this.poller)
    if (this.retry) clearTimeout(this.retry)
    this.poller = this.retry = null
    this.socket?.close()
    this.socket = null
    this.set('offline')
  }

  private connect(): void {
    if (this.stopped) return
    const Socket = this.options.WebSocket ?? globalThis.WebSocket
    if (!Socket) return
    this.set(this.status === 'polling' ? 'polling' : 'connecting')
    const host = this.streams[this.attempt % this.streams.length]
    let socket: WebSocket
    try {
      socket = new Socket(streamUrl(host, this.symbols))
    } catch {
      return this.reconnect()
    }
    this.socket = socket
    socket.onmessage = (event) => {
      try {
        const tick = parseMiniTicker(JSON.parse(String(event.data)))
        if (!tick) return
        this.lastMessage = Date.now()
        this.attempt = 0
        this.set('live')
        this.options.onTick(tick)
      } catch { /* ignore a malformed frame */ }
    }
    socket.onclose = () => {
      if (this.socket === socket) this.reconnect()
    }
    socket.onerror = () => socket.close()
  }

  private reconnect(): void {
    this.socket = null
    if (this.stopped) return
    this.attempt += 1
    this.retry = setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5)))
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    try {
      const ticks = parseTickers(await this.get(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(this.symbols))}`))
      if (Date.now() - this.lastMessage > 6000) {
        this.set('polling')
        for (const tick of ticks) this.options.onTick(tick)
      }
    } catch {
      if (Date.now() - this.lastMessage > 6000) this.set('offline')
    }
  }
}
