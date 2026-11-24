import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../src/core/actions.ts'
import { Alerts } from '../src/core/alerts.ts'
import { PaperBroker, freshPaperState } from '../src/core/paper.ts'
import { DEFAULT_RULES } from '../src/core/types.ts'
import { numberIn, parseCommand, transcribe, wavFromPcm } from '../src/core/voice.ts'
import { App } from '../src/ui/app.ts'
import type { Voice } from '../src/ui/app.ts'
import type { Page, TextBox } from '../src/ui/pages.ts'

const vocabulary = { symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], sizes: [100, 500] }
const parse = (text: string) => parseCommand(text, vocabulary)

test('numbers are understood as digits, with suffixes and spelled out', () => {
  assert.equal(numberIn('above 62,500.5'), 62500.5)
  assert.equal(numberIn('at 62k'), 62000)
  assert.equal(numberIn('62 thousand'), 62000)
  assert.equal(numberIn('1.5 million'), 1_500_000)
  assert.equal(numberIn('sixty two thousand five hundred'), 62500)
  assert.equal(numberIn('five hundred'), 500)
  assert.equal(numberIn('one hundred and twenty'), 120)
  assert.equal(numberIn('in 5 minutes'), 5)
  assert.equal(numberIn('no number here'), null)
})

test('the grammar maps phrases to the same actions a tap offers', () => {
  assert.deepEqual(parse('Sell half.'), { kind: 'action', id: 'half' })
  assert.deepEqual(parse('take fifty percent off'), { kind: 'action', id: 'half' })
  assert.deepEqual(parse('move my stop to break-even'), { kind: 'action', id: 'stop-be' })
  assert.deepEqual(parse('stop to breakeven'), { kind: 'action', id: 'stop-be' })
  assert.deepEqual(parse('trail the stop'), { kind: 'action', id: 'trail' })
  assert.deepEqual(parse('close'), { kind: 'action', id: 'close' })
  assert.deepEqual(parse('get out'), { kind: 'action', id: 'close' })
  assert.deepEqual(parse('close everything'), { kind: 'flatten' })
  assert.deepEqual(parse('flatten'), { kind: 'flatten' })
  assert.deepEqual(parse('buy five hundred'), { kind: 'action', id: 'buy-500' })
  assert.deepEqual(parse('buy 100 USDT'), { kind: 'action', id: 'buy-100' })
  assert.deepEqual(parse('buy'), { kind: 'action', id: 'buy-100' }, 'no amount means the first preset')
  assert.equal(parse('buy 250'), null, 'only preset sizes can be bought by voice')
  assert.deepEqual(parse('add a stop'), { kind: 'action', id: 'bracket' })
  assert.deepEqual(parse('remove the stop'), { kind: 'action', id: 'unprotect' })
  assert.deepEqual(parse('alert above 62,000'), { kind: 'alert', side: 'above', level: 62000 })
  assert.deepEqual(parse('tell me if it goes under sixty thousand'), { kind: 'alert', side: 'below', level: 60000 })
  assert.deepEqual(parse('alert 61.5k'), { kind: 'alert', side: 'cross', level: 61500 })
  assert.equal(parse('alert'), null)
  assert.deepEqual(parse('pause alerts'), { kind: 'alerts', paused: true })
  assert.deepEqual(parse('resume the alerts'), { kind: 'alerts', paused: false })
  assert.deepEqual(parse('show ethereum'), { kind: 'select', symbol: 'ETHUSDT' })
  assert.deepEqual(parse('sol'), { kind: 'select', symbol: 'SOLUSDT' })
  assert.equal(parse('what a lovely day'), null)
  assert.equal(parse(''), null)
})

test('PCM chunks become a valid 16 kHz mono WAV', () => {
  const wav = wavFromPcm([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])])
  const view = new DataView(wav.buffer)
  const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4))
  assert.equal(wav.length, 50)
  assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ['RIFF', 'WAVE', 'fmt ', 'data'])
  assert.equal(view.getUint32(4, true), 42)
  assert.equal(view.getUint16(22, true), 1, 'mono')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000, 'byte rate')
  assert.equal(view.getUint16(34, true), 16, 'bits per sample')
  assert.equal(view.getUint32(40, true), 6)
  assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4, 5, 6])
})

test('transcription posts the audio to an OpenAI-compatible endpoint', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, init }
    return new Response(JSON.stringify({ text: ' Sell half. ' }), { status: 200 })
  }) as unknown as typeof fetch
  const text = await transcribe(wavFromPcm([new Uint8Array(8)]), { url: 'https://stt.example/v1/audio/transcriptions', key: 'k', model: 'whisper-1' }, fetcher)
  assert.equal(text, 'Sell half.')
  const { url, init } = seen as unknown as { url: string; init: RequestInit }
  assert.equal(url, 'https://stt.example/v1/audio/transcriptions')
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer k')
  const form = init.body as FormData
  assert.equal(form.get('model'), 'whisper-1')
  assert.equal((form.get('file') as File).size, 52)

  const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
  await assert.rejects(() => transcribe(new Uint8Array(44), { url: 'https://x', key: '', model: 'm' }, failing), /answered 401/)
})

function setup(voice?: Voice) {
  let clock = 1_000
  const pages: Page[] = []
  const broker = new PaperBroker(freshPaperState(10_000), { feeRate: 0, now: () => clock })
  const alerts = new Alerts()
  const app = new App(['BTCUSDT', 'ETHUSDT'], {
    broker, alerts, settings: DEFAULT_SETTINGS, voice,
    measure: (s) => s.length * 7,
    rulesFor: (symbol) => ({ ...DEFAULT_RULES(symbol), tick: 0.1 }),
    render: (page) => pages.push(page),
    exit: () => {},
    now: () => clock,
    later: () => {},
  })
  const tick = (symbol: string, price: number) => { clock += 1_000; return app.tick({ symbol, price, open24h: price, time: clock }) }
  const textOf = (name: string) => (pages[pages.length - 1].boxes.find((b) => b.name === name) as TextBox | undefined)?.text ?? ''
  return { app, broker, alerts, tick, textOf, key: () => pages[pages.length - 1].key }
}

test('a command only opens the confirmation; the tap is what sends the order', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick('BTCUSDT', 60_000)
  await s.app.command('buy five hundred')
  assert.equal(s.key(), 'confirm')
  assert.match(s.textOf('title'), /Buy 500 USDT of BTC\?/)
  assert.equal((await s.broker.account()).positions.length, 0, 'nothing happened yet')
  await s.app.input('tap')
  assert.equal((await s.broker.account()).positions.length, 1)
  await s.app.input('tap')

  await s.tick('BTCUSDT', 60_700)
  await s.app.command('Stop to break-even.')
  assert.match(s.textOf('title'), /Move stop to break-even\?/)
  await s.app.input('double')
  assert.equal((await s.broker.account()).positions[0].stop, 59_400, 'cancelled: the stop did not move')

  await s.app.command('alert 61k')
  assert.match(s.textOf('body'), /BTC above 61,000\.0/)
  await s.app.input('tap')
  assert.deepEqual(s.alerts.rules.map((r) => [r.kind, r.level]), [['above', 61_000]])
  await s.app.input('tap')

  await s.app.command('alert above 59000')
  assert.match(s.textOf('title'), /Not done/)
  assert.match(s.textOf('body'), /already above 59,000/)
  await s.app.input('tap')

  await s.app.command('show ethereum')
  assert.equal(s.app.selected, 'ETHUSDT')
  await s.app.command('sell half')
  assert.match(s.textOf('body'), /Waiting for a price/, 'no price for ETH yet')
  await s.app.input('tap')

  await s.app.command('close everything')
  assert.match(s.textOf('title'), /Flatten everything\?/)
  await s.app.input('tap')
  assert.equal((await s.broker.account()).positions.length, 0)
  await s.app.input('tap')

  await s.app.command('make me rich')
  assert.match(s.textOf('title'), /Not done/)
  assert.match(s.textOf('body'), /Heard "make me rich"/)
})

test('hold to talk: listening screen, release runs the transcript, double-tap cancels', async () => {
  const log: string[] = []
  let transcript = 'sell half'
  const voice: Voice = {
    available: () => true,
    start: () => { log.push('start') },
    stop: async () => { log.push('stop'); return transcript },
    cancel: () => { log.push('cancel') },
  }
  const s = setup(voice)
  await s.app.refresh()
  await s.tick('BTCUSDT', 60_000)
  await s.broker.buy('BTCUSDT', 500)
  await s.app.refresh()

  await s.app.input('hold')
  assert.equal(s.key(), 'listening')
  await s.app.input('release')
  assert.equal(s.key(), 'confirm')
  assert.match(s.textOf('title'), /Take half off BTC\?/)
  await s.app.input('double')

  await s.app.input('hold')
  await s.app.input('double')
  assert.equal(s.key(), 'session')
  assert.deepEqual(log, ['start', 'stop', 'start', 'cancel'])

  transcript = ''
  await s.app.input('hold')
  await s.app.input('release')
  assert.match(s.textOf('body'), /Heard nothing/)
})

test('without a speech service, holding explains what to do', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick('BTCUSDT', 60_000)
  await s.app.input('hold')
  assert.match(s.textOf('title'), /Not done/)
  assert.match(s.textOf('body'), /Voice is not set up yet/)
})
