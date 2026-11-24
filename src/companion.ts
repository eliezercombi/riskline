// The phone side of the app: the page a user sees in the Even Realities App
// (or in a browser tab when previewing). It mirrors the glasses display and
// holds the settings that are awkward to change with two touchpads.

import * as f from './core/format.ts'
import type { Settings } from './core/actions.ts'
import type { Alerts } from './core/alerts.ts'
import { HINT } from './core/voice.ts'
import type { SttConfig } from './core/voice.ts'
import type { App, Input } from './ui/app.ts'
import { H, W } from './ui/pages.ts'
import type { Page } from './ui/pages.ts'

export interface CompanionApi {
  app: App
  alerts: Alerts
  settings: Settings
  /** True when no glasses bridge was found and gestures come from on-screen buttons. */
  preview: boolean
  feedStatus: () => string
  stats: () => { creates: number; rebuilds: number; upgrades: number; failures: number }
  setWatch: (symbols: string[]) => void
  saveSettings: () => void
  resetPaper: () => void
  stt: () => SttConfig | null
  setStt: (config: SttConfig | null) => void
  /** Run a typed command through the same grammar as voice. */
  command: (text: string) => void
  bridge: () => { url: string; token: string } | null
  setBridge: (bridge: { url: string; token: string } | null) => void
  input: (input: Input) => void
}

const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const LEVELS = [0.18, 0.34, 0.52, 0.76, 1]

function mirror(page: Page | null, preview: boolean): string {
  if (!page) return '<div class="lens"></div>'
  const boxes = page.boxes.map((box) => {
    const frame = `left:${(box.x / W) * 100}%;top:${(box.y / H) * 100}%;width:${(box.w / W) * 100}%;height:${(box.h / H) * 100}%`
    if (box.type === 'list') {
      const items = box.items.map((item, i) => `<button class="li" data-select="${i}" ${preview ? '' : 'disabled'}>${esc(item)}</button>`).join('')
      return `<div class="box list" style="${frame}">${items}</div>`
    }
    if (box.capture) return ''
    return `<div class="box" style="${frame};opacity:${LEVELS[box.level] ?? 1}">${esc(box.text)}</div>`
  }).join('')
  return `<div class="lens">${boxes}</div>`
}

export function mountCompanion(root: HTMLElement, api: CompanionApi): { update: (page: Page) => void } {
  let page: Page | null = null
  let scheduled = false
  let editing = false

  const render = (): void => {
    scheduled = false
    if (editing) return // do not replace inputs under the user's fingers
    const { app, settings } = api
    const views = app.views()
    const held = views.filter((v) => v.held)
    const open = held.reduce((sum, v) => sum + v.pnl, 0)
    const s = api.stats()
    const stt = api.stt()
    const bridge = api.bridge()

    root.innerHTML = `
      <header>
        <h1>Riskline</h1>
        <p class="status"><span class="dot ${esc(api.feedStatus())}"></span>${esc(api.feedStatus())} · ${app.account.mode === 'paper' ? 'paper account' : 'exchange testnet'}${api.preview ? ' · browser preview' : ''}</p>
      </header>

      <section>
        ${mirror(page, api.preview)}
        ${api.preview ? `<div class="pad">
          <button data-input="up">swipe up</button><button data-input="tap">tap</button>
          <button data-input="down">swipe down</button><button data-input="double">double-tap</button>
        </div><p class="fine">No glasses found, so this page stands in for them. The green panel shows what the display would show.</p>` : ''}
      </section>

      <section class="grid">
        <div><span>Free cash</span><b>${f.group(app.account.cash, 2)}</b></div>
        <div><span>Open P&amp;L</span><b>${f.signed(open)}</b></div>
        <div><span>Session P&amp;L</span><b>${f.signed(app.account.realized)}</b></div>
      </section>

      <section>
        <h2>Watchlist</h2>
        <div class="chips">${app.watch.map((symbol) => `<span class="chip">${esc(symbol)}<button data-unwatch="${esc(symbol)}" aria-label="Remove ${esc(symbol)}">×</button></span>`).join('')}</div>
        <form data-form="watch"><input name="symbol" placeholder="Add a pair, e.g. SOLUSDT" autocapitalize="characters" autocomplete="off" maxlength="16"><button>Add</button></form>
      </section>

      <section>
        <h2>Defaults</h2>
        <form data-form="settings" class="fields">
          <label>Entry sizes, USDT<input name="sizes" inputmode="numeric" value="${esc(settings.sizes.join(', '))}"></label>
          <label>Stop, %<input name="stopPct" inputmode="decimal" value="${esc(settings.stopPct * 100)}"></label>
          <label>Target, %<input name="targetPct" inputmode="decimal" value="${esc(settings.targetPct * 100)}"></label>
          <label>Trail, %<input name="trailPct" inputmode="decimal" value="${esc(settings.trailPct * 100)}"></label>
          <label>Quick alert, %<input name="alertPct" inputmode="decimal" value="${esc(settings.alertPct * 100)}"></label>
          <button>Save</button>
        </form>
        <p class="fine">Every new position is opened with this stop and target. Alerts and warnings only ever offer actions that reduce risk.</p>
      </section>

      <section>
        <h2>Commands</h2>
        <form data-form="command"><input name="text" placeholder="${esc(HINT.split(' · ')[0])}" autocomplete="off" maxlength="80"><button>Run</button></form>
        <p class="fine">The same phrases work by voice: hold the touchpad, speak, release. Try: ${esc(HINT)}. A command only opens the confirmation on the glasses; nothing is sent until you tap.</p>
        <form data-form="stt" class="fields stack">
          <label>Speech-to-text URL (OpenAI-compatible)<input name="url" inputmode="url" placeholder="https://api.openai.com/v1/audio/transcriptions" value="${esc(stt?.url ?? '')}" autocomplete="off"></label>
          <label>Model<input name="model" placeholder="whisper-1" value="${esc(stt?.model ?? '')}" autocomplete="off"></label>
          <label>API key<input name="key" type="password" placeholder="stays on this phone" value="${esc(stt?.key ?? '')}" autocomplete="off"></label>
          <button>${stt ? 'Update voice' : 'Turn on voice'}</button>
        </form>
      </section>

      <section>
        <h2>Alerts</h2>
        ${api.alerts.rules.length ? `<ul class="rows">${api.alerts.rules.map((rule) => `<li>${esc(rule.symbol)} ${esc(rule.kind)} ${f.price(rule.level)}<button data-unalert="${esc(rule.id)}">Remove</button></li>`).join('')}</ul>` : '<p class="fine">None armed. Set them from the glasses: tap, then “Alert above” or “Alert below”.</p>'}
      </section>

      <section>
        <h2>Account</h2>
        <div class="pad">
          <button data-flatten ${held.length ? '' : 'disabled'}>Flatten all</button>
          ${bridge ? '<button data-paper>Back to paper account</button>' : '<button data-reset>Reset paper account</button>'}
        </div>
        <form data-form="bridge" class="fields stack">
          <label>Testnet bridge URL<input name="url" inputmode="url" placeholder="http://localhost:8787" value="${esc(bridge?.url ?? '')}" autocomplete="off"></label>
          <label>Bridge token<input name="token" type="password" placeholder="printed when the bridge starts" value="${esc(bridge?.token ?? '')}" autocomplete="off"></label>
          <button>${bridge ? 'Reconnect' : 'Use Binance Spot Testnet'}</button>
        </form>
        <p class="fine">Paper mode needs nothing. To place real testnet orders, run the bridge from this repository with your own Spot Testnet key; the key stays on that machine.</p>
        <p class="fine">Display traffic this session: ${s.creates} page start, ${s.rebuilds} rebuilds, ${s.upgrades} text updates, ${s.failures} failed calls.</p>
      </section>`
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    // A timer, not requestAnimationFrame: the mirror must keep up while the page is in the background.
    setTimeout(render, 30)
  }

  root.addEventListener('focusin', (event) => { if ((event.target as HTMLElement).tagName === 'INPUT') editing = true })
  root.addEventListener('focusout', () => { editing = false; schedule() })

  root.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!el || el.disabled) return
    const data = el.dataset
    if (data.input) api.input(data.input as Input)
    else if (data.select) api.input({ select: Number(data.select) })
    else if (data.unwatch) api.setWatch(api.app.watch.filter((symbol) => symbol !== data.unwatch))
    else if (data.unalert) { api.alerts.remove(data.unalert); api.saveSettings() }
    else if ('flatten' in data) api.input({ menu: 1 })
    else if ('reset' in data) api.resetPaper()
    else if ('paper' in data) api.setBridge(null)
    else return
    schedule()
  })

  root.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const values = new FormData(form)
    if (form.dataset.form === 'watch') {
      const symbol = String(values.get('symbol') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (symbol.length >= 5 && !api.app.watch.includes(symbol)) api.setWatch([...api.app.watch, symbol])
    }
    if (form.dataset.form === 'command') {
      const text = String(values.get('text') ?? '').trim()
      if (text) api.command(text)
    }
    if (form.dataset.form === 'stt') {
      const url = String(values.get('url') ?? '').trim()
      if (!url) api.setStt(null)
      else if (/^https?:\/\/\S+$/.test(url)) api.setStt({ url, model: String(values.get('model') ?? '').trim() || 'whisper-1', key: String(values.get('key') ?? '').trim() })
    }
    if (form.dataset.form === 'bridge') {
      const url = String(values.get('url') ?? '').trim()
      const token = String(values.get('token') ?? '').trim()
      if (/^https?:\/\/\S+$/.test(url) && token) api.setBridge({ url, token })
    }
    if (form.dataset.form === 'settings') {
      const ratio = (name: string, fallback: number, max: number): number => {
        const value = Number(String(values.get(name)).replace(',', '.')) / 100
        return value > 0 && value <= max ? value : fallback
      }
      const sizes = String(values.get('sizes')).split(/[^0-9.]+/).map(Number).filter((n) => n >= 5 && n <= 1_000_000).slice(0, 3)
      if (sizes.length) api.settings.sizes = sizes
      api.settings.stopPct = ratio('stopPct', api.settings.stopPct, 0.5)
      api.settings.targetPct = ratio('targetPct', api.settings.targetPct, 5)
      api.settings.trailPct = ratio('trailPct', api.settings.trailPct, 0.5)
      api.settings.alertPct = ratio('alertPct', api.settings.alertPct, 0.5)
      api.saveSettings()
    }
    editing = false
    ;(document.activeElement as HTMLElement | null)?.blur()
    schedule()
  })

  schedule()
  return {
    update(next: Page) {
      page = next
      schedule()
    },
  }
}
