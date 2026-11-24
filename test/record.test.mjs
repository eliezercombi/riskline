// The demo recorder: playing a story against the simulator's API and laying out the video.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ACTIONS, build, filterPath, play, segmentArgs, simulator, wrapCaption } from '../scripts/record.mjs'

/** A simulator whose picture changes with every input. */
function fakeSimulator({ ready = true, errors = [] } = {}) {
  const sent = []
  let picture = 0
  const sim = {
    ping: async () => true,
    input: async (action) => { sent.push(action); picture += 1 },
    frame: async () => Buffer.from(`picture ${picture}`),
    console: async () => [...(ready ? [{ level: 'log', message: '[riskline] ready (glasses bridge, relay)' }] : []), ...errors],
  }
  return { sim, sent }
}

const noPause = async () => {}

test('a story is played in order and every distinct picture is kept once', async () => {
  const { sim, sent } = fakeSimulator()
  const story = {
    ready: '[riskline] ready',
    scenes: [
      { caption: 'First look', hold: 3 },
      { caption: 'Swipe', actions: ['down', { wait: 500 }, 'down'], hold: 2 },
      { caption: 'Swipe' },
    ],
  }
  const { timeline, errors } = await play(story, sim, { pause: noPause })
  assert.deepEqual(sent, ['down', 'down'])
  assert.deepEqual(timeline.map((entry) => [entry.png.toString(), entry.seconds, entry.caption]), [
    ['picture 0', 3, 'First look'],
    ['picture 1', 0.8, 'Swipe'],
    // After the second swipe the picture does not change again, so its beat, its hold
    // and the next scene's default hold add up on one entry.
    ['picture 2', 0.8 + 2 + 2.5, 'Swipe'],
  ])
  assert.deepEqual(errors, [])
})

test('the recorder waits for the app and reports what the app logged', async () => {
  await assert.rejects(() => play({ ready: '[riskline] ready', scenes: [] }, fakeSimulator({ ready: false }).sim, { pause: noPause }), /never logged/)
  await assert.rejects(() => play({ scenes: [] }, { ping: async () => false }, { pause: noPause }), /not answering/)

  const { sim } = fakeSimulator({ errors: [{ level: 'error', message: '[fetch] 500 http://localhost:8788/today' }] })
  assert.deepEqual((await play({ scenes: [{ caption: 'x' }] }, sim, { pause: noPause })).errors, ['[fetch] 500 http://localhost:8788/today'])
})

test('the simulator client speaks the automation API', async () => {
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url, init.body ?? null])
    if (url.endsWith('/api/ping')) return new Response('pong')
    if (url.endsWith('/api/console')) return new Response(JSON.stringify({ entries: [{ id: 0, level: 'log', message: 'hi' }], total: 1 }))
    if (url.endsWith('/api/screenshot/glasses')) return new Response(Buffer.from([137, 80, 78, 71]))
    return new Response('{"ok":true}')
  }
  const sim = simulator('http://127.0.0.1:9898/', fetcher)
  assert.equal(await sim.ping(), true)
  await sim.input('long_press')
  assert.deepEqual(calls.at(-1), ['POST', 'http://127.0.0.1:9898/api/input', '{"action":"long_press"}'])
  assert.deepEqual([...(await sim.frame())], [137, 80, 78, 71])
  assert.equal((await sim.console())[0].message, 'hi')
  await assert.rejects(() => sim.input('swipe_left'), /Unknown action "swipe_left"/)
  assert.deepEqual(ACTIONS, ['up', 'down', 'click', 'double_click', 'long_press', 'long_press_release', 'context_menu'])
  assert.equal(await simulator('http://x', async () => { throw new Error('refused') }).ping(), false)
})

test('captions wrap to two lines and paths survive ffmpeg filter syntax', () => {
  assert.deepEqual(wrapCaption('Short one.'), ['Short one.'])
  const long = wrapCaption('Hold the touchpad and say a task. (No microphone in an automated run: this transcript is scripted.)')
  assert.equal(long.length, 2)
  assert.ok(long[0].length <= 74)
  assert.equal(long.join(' '), 'Hold the touchpad and say a task. (No microphone in an automated run: this transcript is scripted.)')
  assert.deepEqual(wrapCaption(''), [])
  assert.equal(filterPath('C:\\Windows\\Fonts\\segoeui.ttf'), 'C\\:/Windows/Fonts/segoeui.ttf')

  const args = segmentArgs({ frame: 'frames/001.png', seconds: 2.5, captionFiles: ['parts/001.caption0.txt', 'parts/001.caption1.txt'], headerFile: 'parts/header.txt', titleFile: null, font: 'C:/Windows/Fonts/segoeui.ttf', output: 'parts/001.mp4' })
  const chain = args[args.indexOf('-filter_complex') + 1]
  assert.match(chain, /^\[1:v\]scale=1152:576:flags=neighbor\[glasses\];\[0:v\]\[glasses\]overlay=64:48\[base\];\[base\]drawbox=/)
  assert.equal(chain.match(/drawtext=/g).length, 3, 'header and two caption lines')
  assert.ok(chain.includes("fontfile='C\\:/Windows/Fonts/segoeui.ttf'"))
  assert.equal(args.at(-1), 'parts/001.mp4')

  const card = segmentArgs({ frame: null, seconds: 3, captionFiles: [], headerFile: null, titleFile: 'parts/000.title.txt', font: '/f.ttf', output: 'parts/000.mp4' })
  assert.equal(card.includes('-loop'), false, 'a title card has no picture input')
  assert.match(card[card.indexOf('-filter_complex') + 1], /^\[0:v\]null\[base\];\[base\]drawtext=/)
})

test('frames, captions and the timeline are written out; the bundled story is valid', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'record-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const { sim } = fakeSimulator()
  const story = { title: 'Riskline', subtitle: 'Risk on G2', note: 'simulator', outro: 'example.org', scenes: [{ caption: 'First look', hold: 3 }, { caption: 'Swipe', actions: ['down'] }] }
  const { timeline } = await play(story, sim, { pause: noPause })
  const result = await build(story, timeline, out, { video: false })
  assert.deepEqual(result, { frames: 2, seconds: 3 + 3 + 0.8 + 2.5 + 4, video: null })
  assert.deepEqual((await readdir(join(out, 'frames'))).sort(), ['001.png', '002.png'])
  const written = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'))
  assert.deepEqual(written.map((entry) => [entry.frame, entry.title, entry.caption]), [[null, 'Riskline', 'Risk on G2'], ['frames/001.png', '', 'First look'], ['frames/002.png', '', 'Swipe'], [null, 'example.org', '']])
  assert.equal(await readFile(join(out, 'parts', '001.caption0.txt'), 'utf8'), 'First look')

  const bundled = JSON.parse(await readFile(new URL('../scripts/story.json', import.meta.url), 'utf8'))
  const seconds = bundled.scenes.reduce((sum, scene) => sum + (scene.hold ?? 2.5) + (scene.actions ?? []).filter((a) => typeof a === 'string').length * 0.8, 0)
  assert.ok(seconds < 150, `the story runs about ${Math.round(seconds)} s, under the 3 minute limit with room for cards`)
  for (const scene of bundled.scenes) {
    for (const action of scene.actions ?? []) assert.ok(typeof action === 'object' ? action.wait >= 0 : ACTIONS.includes(action), JSON.stringify(action))
    assert.ok(wrapCaption(scene.caption).every((line) => line.length <= 80), scene.caption)
  }
})
