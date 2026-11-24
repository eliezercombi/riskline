// Text formatting for a 576x288 monochrome display with one proportional font.
// Only ASCII plus glyphs the G2 firmware font is documented to carry are used:
// block elements for sparklines, heavy/light lines and a dot for gauges, arrows.

const BLOCKS = '▁▂▃▄▅▆▇█'

/** Decimals that keep about five significant digits visible for a price. */
export function priceDecimals(price: number): number {
  const p = Math.abs(price)
  if (p >= 1000) return 1
  if (p >= 10) return 2
  if (p >= 1) return 3
  if (p >= 0.01) return 5
  return 7
}

export function group(n: number, decimals: number): string {
  const [whole, frac] = Math.abs(n).toFixed(decimals).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (n < 0 ? '-' : '') + grouped + (frac ? `.${frac}` : '')
}

export const price = (value: number, decimals = priceDecimals(value)): string => group(value, decimals)

/** Quantity with trailing zeros trimmed: 0.1500 -> 0.15, 2.0 -> 2. */
export function qty(value: number, maxDecimals = 6): string {
  const fixed = value.toFixed(maxDecimals)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** True when `value` shows as zero at this precision, so "-0.00" is never printed. */
const zeroAt = (value: number, decimals: number): boolean => Math.abs(value) < 0.5 / 10 ** decimals

export const signed = (value: number, decimals = 2): string => (value >= 0 || zeroAt(value, decimals) ? '+' : '-') + group(Math.abs(value), decimals)

export const pct = (ratio: number, decimals = 2): string => `${ratio >= 0 || zeroAt(ratio * 100, decimals) ? '+' : '-'}${Math.abs(ratio * 100).toFixed(decimals)}%`

export const arrow = (ratio: number): string => (ratio > 0 ? '▲' : ratio < 0 ? '▼' : '▶')

/** R multiple with one decimal: +0.9R, -1.0R. */
export const rMultiple = (r: number): string => `${r >= 0 || zeroAt(r, 1) ? '+' : '-'}${Math.abs(r).toFixed(1)}R`

/** Resample a series to `cells` buckets and draw it with block glyphs. */
export function sparkline(values: number[], cells: number): string {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length === 0 || cells <= 0) return ''
  const buckets: number[] = []
  for (let i = 0; i < cells; i++) {
    const from = Math.floor((i * clean.length) / cells)
    const to = Math.max(from + 1, Math.floor(((i + 1) * clean.length) / cells))
    const slice = clean.slice(from, Math.min(to, clean.length))
    buckets.push(slice.length ? slice[slice.length - 1] : clean[clean.length - 1])
  }
  const lo = Math.min(...buckets)
  const hi = Math.max(...buckets)
  if (hi === lo) return BLOCKS[3].repeat(cells)
  return buckets.map((v) => BLOCKS[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8))]).join('')
}

/**
 * Where the price sits between stop and target, as a one-line gauge:
 *   ━━━━━━●─────────
 * Travelled distance is heavy, the remainder light. The marker pins to an end
 * when the price is outside the range.
 */
export function gauge(stop: number, current: number, target: number, cells: number): string {
  if (!(target > stop) || cells < 3) return ''
  const ratio = Math.min(1, Math.max(0, (current - stop) / (target - stop)))
  const at = Math.min(cells - 1, Math.round(ratio * (cells - 1)))
  return '━'.repeat(at) + '●' + '─'.repeat(cells - 1 - at)
}

export type Measure = (text: string) => number

/**
 * Number of spaces that fills `gapPx` without overshooting. The estimate from
 * one space is corrected against a real measurement of the run, because a
 * rounded single-space width drifts over dozens of spaces.
 */
function spaces(gapPx: number, measure: Measure): number {
  const one = measure(' ') || 1
  let count = Math.max(0, Math.floor(gapPx / one))
  while (count > 0 && measure(' '.repeat(count)) > gapPx) count -= 1
  while (measure(' '.repeat(count + 1)) <= gapPx) count += 1
  return count
}

/** Left-pad with spaces so that `text` ends at `widthPx` (the font is proportional). */
export function alignRight(text: string, widthPx: number, measure: Measure): string {
  return ' '.repeat(spaces(widthPx - measure(text), measure)) + text
}

/** `left` and `right` on one line, pushed to the edges of `widthPx`. */
export function spread(left: string, right: string, widthPx: number, measure: Measure): string {
  // One space short on purpose: a line that lands exactly on the edge may wrap.
  const pad = Math.max(2, spaces(widthPx - measure(left) - measure(right), measure) - 1)
  let line = left + ' '.repeat(pad) + right
  for (let n = pad; n > 2 && measure(line) > widthPx; n -= 1) line = left + ' '.repeat(n - 1) + right
  return line
}

/** Cut a string to a pixel budget, ending with three dots when shortened. */
export function fit(text: string, widthPx: number, measure: Measure): string {
  if (measure(text) <= widthPx) return text
  let out = text
  while (out.length > 1 && measure(`${out}...`) > widthPx) out = out.slice(0, -1)
  return `${out.trimEnd()}...`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}
