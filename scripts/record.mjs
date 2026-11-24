#!/usr/bin/env node
// Records the demo from the Even Hub simulator, so the video can be reproduced.
//
// A story is a list of scenes: a caption and some touchpad actions. The script
// plays them through the simulator's automation API, saves the glasses
// framebuffer after every step, and turns the frames into an MP4 with captions
// using ffmpeg. Node built-ins only.
//
//   npm run dev
//   evenhub-simulator "http://localhost:5173/?relay=dev" --automation-port 9898
//   node scripts/record.mjs scripts/story.json
//
// Options: --sim <url> (http://127.0.0.1:9898), --out <dir> (demo), --no-video,
//          --font <file> (a .ttf for the captions), --ffmpeg <binary>

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ACTIONS = ['up', 'down', 'click', 'double_click', 'long_press', 'long_press_release', 'context_menu']

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Thin client for the simulator's HTTP control plane. */
export function simulator(base, fetcher = fetch) {
  const url = (path) => `${base.replace(/\/+$/, '')}${path}`
  return {
    async ping() {
      const response = await fetcher(url('/api/ping')).catch(() => null)
      return Boolean(response?.ok)
    },
    async input(action) {
      if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}`)
      const response = await fetcher(url('/api/input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      if (!response.ok) throw new Error(`The simulator refused "${action}": ${response.status} ${await response.text()}`)
    },
    async frame() {
      const response = await fetcher(url('/api/screenshot/glasses'))
      if (!response.ok) throw new Error(`No screenshot: ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    },
    async console() {
      const response = await fetcher(url('/api/console'))
      return response.ok ? (await response.json()).entries ?? [] : []
    },
  }
}

/**
 * Play a story and collect frames. Returns the timeline: one entry per distinct
 * picture, with how long it stays on screen and the caption under it.
 */
export async function play(story, sim, { pause = sleep, log = () => {} } = {}) {
  if (!(await sim.ping())) throw new Error('The simulator is not answering. Start it with --automation-port.')

  if (story.ready) {
    // Input is dropped until the app has created its first page, so wait for its own "ready" line.
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = (await sim.console()).some((entry) => String(entry.message).includes(story.ready))
      if (!ready) await pause(500)
    }
    if (!ready) throw new Error(`The app never logged "${story.ready}"`)
  }

  const step = story.step ?? 450
  const timeline = []
  const keep = (png, seconds, caption) => {
    const last = timeline[timeline.length - 1]
    // The same picture under the same caption just stays up longer.
    if (last && last.caption === caption && last.png.equals(png)) last.seconds += seconds
    else timeline.push({ png, seconds, caption })
  }

  for (const scene of story.scenes) {
    const caption = scene.caption ?? ''
    log(`scene: ${caption}`)
    for (const action of scene.actions ?? []) {
      if (typeof action === 'object') {
        await pause(action.wait ?? 0)
        continue
      }
      await sim.input(action)
      await pause(step)
      keep(await sim.frame(), story.beat ?? 0.8, caption)
    }
    await pause(scene.settle ?? 600)
    keep(await sim.frame(), scene.hold ?? 2.5, caption)
  }

  const errors = (await sim.console()).filter((entry) => entry.level === 'error').map((entry) => String(entry.message))
  return { timeline, errors }
}

/** Split a caption into at most two lines of about `width` characters, breaking between words. */
export function wrapCaption(caption, width = 74) {
  const words = String(caption).split(/\s+/).filter(Boolean)
  const lines = ['']
  for (const word of words) {
    const last = lines.length - 1
    if (lines[last] && (lines[last] + ' ' + word).length > width && lines.length < 2) lines.push(word)
    else lines[last] = lines[last] ? lines[last] + ' ' + word : word
  }
  return lines.filter(Boolean)
}

/** Escape a path for use inside an ffmpeg filter option. */
export const filterPath = (path) => path.replace(/\\/g, '/').replace(/:/g, '\\:')

const defaultFont = () => ({
  win32: 'C:/Windows/Fonts/segoeui.ttf',
  darwin: '/System/Library/Fonts/Supplemental/Arial.ttf',
}[process.platform] ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

/**
 * ffmpeg arguments for one segment: the 576x288 framebuffer doubled on a black
 * 1280x720 canvas, the app name above it and the caption below. Paths are
 * relative to the output folder, so only the font needs escaping.
 */
export function segmentArgs({ frame, seconds, captionFiles = [], headerFile, titleFile, font, output }) {
  const text = (file, size, y, colour) => `drawtext=fontfile='${filterPath(font)}':textfile=${file}:fontcolor=${colour}:fontsize=${size}:x=(w-text_w)/2:y=${y}`
  // Each step draws on the result of the one before; steps without a text file are skipped.
  const steps = [
    frame ? 'drawbox=x=60:y=44:w=1160:h=584:color=0x1f3d28:t=2' : null,
    headerFile ? text(headerFile, 20, 12, '0x7f8a80') : null,
    titleFile ? text(titleFile, 60, '(h/2)-90', 'white') : null,
    // Caption lines are drawn one by one so that each is centred.
    ...captionFiles.map((file, line) => text(file, 30, frame ? (captionFiles.length > 1 ? 640 : 656) + line * 36 : `(h/2)+${10 + line * 40}`, frame ? 'white' : '0xb8c4bb')),
  ].filter(Boolean)
  const chain = [
    frame ? '[1:v]scale=1152:576:flags=neighbor[glasses];[0:v][glasses]overlay=64:48[base]' : '[0:v]null[base]',
    `[base]${steps.length ? steps.join(',') : 'null'}[out]`,
  ].join(';')
  return [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-t', String(seconds), '-i', 'color=c=black:s=1280x720:r=30',
    ...(frame ? ['-loop', '1', '-t', String(seconds), '-i', frame] : []),
    '-filter_complex', chain, '-map', '[out]',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    output,
  ]
}

function run(binary, args, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', (error) => fail(new Error(`Could not start ${binary}: ${error.message}`)))
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${binary} exited with ${code}`))))
  })
}

/** Write the frames and build the video in `outDir`. */
export async function build(story, timeline, outDir, { ffmpeg = 'ffmpeg', font = defaultFont(), video = true } = {}) {
  await mkdir(join(outDir, 'frames'), { recursive: true })
  await mkdir(join(outDir, 'parts'), { recursive: true })
  const header = `${story.title ?? ''}${story.note ? `   ·   ${story.note}` : ''}`
  await writeFile(join(outDir, 'parts', 'header.txt'), header)

  // A title card, the recorded pictures, and a closing card.
  const cards = [
    { title: story.title ?? '', caption: story.subtitle ?? '', seconds: story.intro ?? 3 },
    ...timeline,
    ...(story.outro ? [{ title: story.outro, caption: story.outroNote ?? '', seconds: 4 }] : []),
  ]
  const list = []
  for (const [index, entry] of cards.entries()) {
    const id = String(index).padStart(3, '0')
    const frame = entry.png ? `frames/${id}.png` : null
    if (entry.png) await writeFile(join(outDir, frame), entry.png)
    // ffmpeg reads texts from files, so captions need no escaping.
    const file = async (kind, text) => {
      if (!text) return null
      await writeFile(join(outDir, 'parts', `${id}.${kind}.txt`), text)
      return `parts/${id}.${kind}.txt`
    }
    const lines = wrapCaption(entry.caption ?? '')
    const captionFiles = []
    for (const [n, line] of lines.entries()) captionFiles.push(await file(`caption${n}`, line))
    list.push({ id, frame, seconds: entry.seconds, caption: entry.caption ?? '', title: entry.title ?? '', captionFiles, titleFile: await file('title', entry.title) })
  }
  await writeFile(join(outDir, 'timeline.json'), JSON.stringify(list.map(({ id, frame, seconds, title, caption }) => ({ id, frame, seconds, title, caption })), null, 2))
  if (!video) return { frames: timeline.length, seconds: list.reduce((sum, e) => sum + e.seconds, 0), video: null }

  for (const entry of list) {
    await run(ffmpeg, segmentArgs({ ...entry, headerFile: entry.frame && header ? 'parts/header.txt' : null, font, output: `parts/${entry.id}.mp4` }), outDir)
  }
  await writeFile(join(outDir, 'parts', 'list.txt'), list.map((entry) => `file '${entry.id}.mp4'`).join('\n'))
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'parts/list.txt', '-c', 'copy', '-movflags', '+faststart', 'demo.mp4'], outDir)
  return { frames: timeline.length, seconds: list.reduce((sum, e) => sum + e.seconds, 0), video: join(outDir, 'demo.mp4') }
}

async function main(argv) {
  const flags = { sim: 'http://127.0.0.1:9898', out: 'demo', video: true }
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-video') flags.video = false
    else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i]
    else files.push(arg)
  }
  if (!files[0]) throw new Error('Usage: node scripts/record.mjs <story.json> [--sim url] [--out dir] [--no-video]')

  const story = JSON.parse(await readFile(files[0], 'utf8'))
  const { timeline, errors } = await play(story, simulator(flags.sim), { log: console.log })
  const result = await build(story, timeline, resolve(flags.out), { ffmpeg: flags.ffmpeg, font: flags.font, video: flags.video })
  console.log(`${result.frames} pictures, ${result.seconds.toFixed(1)} s${result.video ? ` -> ${result.video}` : ''}`)
  if (result.seconds > 180) console.log('Longer than the 3 minute limit: shorten some holds.')
  if (errors.length) {
    console.log(`The app logged ${errors.length} error(s) during the run:\n  ${errors.join('\n  ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
