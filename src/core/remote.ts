// Venue backed by the Riskline bridge (server/bridge.mjs), which holds the
// exchange key and places real orders on the Binance Spot Testnet.

import type { Account, Broker, Fill, Position } from './types.ts'

export class RemoteBroker implements Broker {
  private base: string
  private token: string
  private fetcher: typeof fetch
  private cursor = ''

  constructor(base: string, token: string, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.base = base.replace(/\/+$/, '')
    this.token = token
    this.fetcher = fetcher
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new Error('The bridge is not reachable')
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new Error(payload.error ?? `The bridge answered ${response.status}`)
    return payload as T
  }

  account(): Promise<Account> {
    return this.call('GET', '/account')
  }

  buy(symbol: string, quoteAmount: number): Promise<Fill> {
    return this.call('POST', '/buy', { symbol, quote: quoteAmount })
  }

  sell(symbol: string, fraction: number): Promise<Fill> {
    return this.call('POST', '/sell', { symbol, fraction })
  }

  protect(symbol: string, levels: { stop?: number | null; target?: number | null }): Promise<Position> {
    return this.call('POST', '/protect', { symbol, ...levels })
  }

  flatten(): Promise<Fill[]> {
    return this.call('POST', '/flatten', {})
  }

  /** Fills since the last call. The first call only sets the starting point. */
  async poll(): Promise<Fill[]> {
    const events = await this.call<Fill[]>('GET', `/events?since=${encodeURIComponent(this.cursor)}`)
    const first = this.cursor === ''
    if (events.length) this.cursor = events[events.length - 1].id
    else if (first) this.cursor = 't0'
    return first ? [] : events
  }
}
