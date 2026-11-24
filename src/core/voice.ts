// Voice: a small command grammar, a WAV encoder for the glasses' PCM stream and
// a client for any OpenAI-compatible transcription endpoint.
//
// A spoken command never executes anything by itself. It only chooses what the
// confirmation screen shows; the tap that follows is what sends the order.

export type Command =
  | { kind: 'action'; id: string }
  | { kind: 'alert'; side: 'above' | 'below' | 'cross'; level: number }
  | { kind: 'flatten' }
  | { kind: 'select'; symbol: string }
  | { kind: 'alerts'; paused: boolean }

export interface Vocabulary {
  /** Symbols on screen, e.g. BTCUSDT. */
  symbols: string[]
  /** Entry sizes offered as buttons; "buy 500" has to name one of them. */
  sizes: number[]
}

const NAMES: Record<string, string> = {
  bitcoin: 'BTC', ether: 'ETH', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', doge: 'DOGE',
  cardano: 'ADA', binance: 'BNB', avalanche: 'AVAX', chainlink: 'LINK', toncoin: 'TON', litecoin: 'LTC', polkadot: 'DOT',
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/**
 * First number in a phrase. Understands digits with separators ("62,500.5"),
 * a k/m suffix or the words thousand/million ("62k", "62 thousand"), and
 * spelled-out numbers ("sixty two thousand five hundred").
 */
export function numberIn(text: string): number | null {
  const digits = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/)
  if (digits) {
    const value = Number(digits[1].replace(/,/g, ''))
    const scale = digits[2] ? (/^m/.test(digits[2]) ? 1e6 : 1e3) : 1
    return Number.isFinite(value) ? value * scale : null
  }
  let total = 0
  let current = 0
  let seen = false
  for (const word of text.split(/[\s-]+/)) {
    if (word in UNITS) { current += UNITS[word]; seen = true }
    else if (word === 'hundred' && seen) current *= 100
    else if (word === 'thousand' && seen) { total += current * 1e3; current = 0 }
    else if (word === 'million' && seen) { total += current * 1e6; current = 0 }
    else if (word === 'and' && seen) continue
    else if (seen) break
  }
  return seen ? total + current : null
}

export function parseCommand(spoken: string, vocabulary: Vocabulary): Command | null {
  // Hyphens become spaces, so "break-even" and "sixty-two" read like their spoken forms.
  const text = spoken.toLowerCase().replace(/[^a-z0-9.,%\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const has = (pattern: RegExp) => pattern.test(text)

  if (has(/\b(pause|mute|silence|stop) (the )?alerts?\b/)) return { kind: 'alerts', paused: true }
  if (has(/\b(resume|unmute|enable|start) (the )?alerts?\b/)) return { kind: 'alerts', paused: false }

  if (has(/\b(flatten|close|sell|exit) (all|everything)\b/) || has(/\bflat(ten)?\b/)) return { kind: 'flatten' }

  if (has(/\balert|alarm|notify|tell me\b/)) {
    const level = numberIn(text.replace(/^.*?\b(alert|alarm|notify|tell me)\b/, ''))
    if (level && level > 0) {
      const side = has(/\b(above|over|higher|up)\b/) ? 'above' : has(/\b(below|under|lower|down)\b/) ? 'below' : 'cross'
      return { kind: 'alert', side, level }
    }
    return null
  }

  if (has(/\b(break ?even|breakeven|to entry|risk ?free)\b/)) return { kind: 'action', id: 'stop-be' }
  if (has(/\btrail/)) return { kind: 'action', id: 'trail' }
  if (has(/\b(half|fifty percent|50 ?%|50 percent)\b/)) return { kind: 'action', id: 'half' }
  if (has(/\b(remove|cancel|clear) (the )?(stop|protection|orders)\b/)) return { kind: 'action', id: 'unprotect' }
  if (has(/\b(protect|add (a )?stop|set (a )?stop|bracket)\b/)) return { kind: 'action', id: 'bracket' }

  if (has(/\b(buy|long|add)\b/)) {
    const amount = numberIn(text.replace(/^.*?\b(buy|long|add)\b/, ''))
    const size = amount === null ? vocabulary.sizes[0] : vocabulary.sizes.find((s) => s === amount)
    return size === undefined ? null : { kind: 'action', id: `buy-${size}` }
  }

  if (has(/\b(close|sell|exit|get out|take profit)\b/)) return { kind: 'action', id: 'close' }

  for (const symbol of vocabulary.symbols) {
    const base = symbol.replace(/USDT$|USDC$|FDUSD$/, '').toLowerCase()
    const spokenAs = Object.entries(NAMES).filter(([, ticker]) => ticker.toLowerCase() === base).map(([name]) => name)
    if ([base, ...spokenAs].some((word) => new RegExp(`\\b${word}\\b`).test(text))) return { kind: 'select', symbol }
  }
  return null
}

export const HINT = 'sell half · stop to break-even · close · buy 500 · alert 62000'

/** Wrap raw 16-bit little-endian mono PCM in a WAV header. */
export function wavFromPcm(chunks: Uint8Array[], sampleRate = 16_000): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(44 + size)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + size, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, size, true)
  let offset = 44
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

export interface SttConfig {
  /** Full URL of an OpenAI-compatible endpoint, e.g. https://api.openai.com/v1/audio/transcriptions */
  url: string
  key: string
  model: string
}

export async function transcribe(wav: Uint8Array, config: SttConfig, fetcher: typeof fetch = fetch.bind(globalThis)): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'command.wav')
  form.append('model', config.model)
  form.append('language', 'en')
  form.append('response_format', 'json')
  // Bias the recogniser towards the words the grammar knows.
  form.append('prompt', 'Trading commands: sell half, stop to break-even, close, trail stop, buy 500, alert above 62000, flatten all.')
  const response = await fetcher(config.url, { method: 'POST', headers: config.key ? { Authorization: `Bearer ${config.key}` } : {}, body: form })
  if (!response.ok) throw new Error(`Speech service answered ${response.status}`)
  const payload = (await response.json()) as { text?: string }
  return (payload.text ?? '').trim()
}
