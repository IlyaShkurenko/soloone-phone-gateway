// Runs every WhatsApp screen flow on a test phone without sending anything (PGW-14).
// Usage: node dist/selftest.js --from <sender number> --to <recipient number> [--react-text <text>]
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { findDevice, whatsappPackage } from './devices.js'
import { connect, release } from './drivers/index.js'
import { RunError, runScript, type RunRequest, type TraceEntry } from './executor.js'
import { log } from './logger.js'
import { loadScript } from './scripts.js'

interface Check {
  name: string
  ok: boolean
  seconds: number
  step?: string
  error?: string
  skipped?: boolean
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

const from = arg('from')
const to = arg('to')
if (!from || !to || !/^\d{7,15}$/.test(from) || !/^\d{7,15}$/.test(to)) {
  console.error('Usage: selftest --from <digits> --to <digits> [--react-text <text>]')
  process.exit(2)
}

const dir = path.join(config.stateDir, 'selftest')
await mkdir(dir, { recursive: true })
const photo = path.join(dir, 'selftest.png')
const video = path.join(dir, 'selftest.mov')
execFileSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=720x1280:d=1', '-frames:v', '1', photo])
execFileSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=480x854:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
  '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mov', video])
const server = createServer(async (req, res) => {
  const file = req.url === '/photo.png' ? photo : req.url === '/video.mov' ? video : null
  if (!file) return void res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': file === photo ? 'image/png' : 'video/quicktime' })
  res.end(await readFile(file))
}).listen(0, '127.0.0.1')
const port = (server.address() as { port: number }).port
const url = (name: string) => `http://127.0.0.1:${port}/${name}`

const checks: Check[] = []
const device = await findDevice(from)
if (!device) {
  console.error(`No phone is registered for ${from}`)
  process.exit(2)
}

async function check(name: string, scriptName: string, request: Omit<RunRequest, 'pkg' | 'messageId'>, skipUnless?: () => boolean): Promise<void> {
  if (skipUnless && !skipUnless()) {
    checks.push({ name, ok: true, skipped: true, seconds: 0 })
    return
  }
  const started = Date.now()
  let serial: string | undefined
  try {
    serial = await connect(device!)
    const result = await runScript(serial, await loadScript(scriptName), {
      ...request, messageId: `selftest-${Date.now()}`, pkg: whatsappPackage(device!)
    }, { dryRun: true, startedAt: Date.now(), onSendPressed: async () => { throw new Error('Self-test must not send') } })
    const ok = result.outcome === 'stopped_before_send'
    checks.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000), step: result.trace.at(-1)?.op, error: ok ? undefined : `unexpected outcome ${result.outcome}` })
  } catch (error) {
    const trace: TraceEntry[] = error instanceof RunError ? error.trace : []
    checks.push({
      name, ok: false, seconds: Math.round((Date.now() - started) / 1000),
      step: trace.at(-1) ? `${trace.at(-1)!.step}:${trace.at(-1)!.op}` : undefined,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    if (serial) release(device!, serial)
  }
}

const reactText = arg('react-text')
await check('text', 'send_text', { to, text: 'Selftest text, no send', typingTimeMs: 1500 })
await check('photo view once with caption', 'send_media', { to, media: { type: 'image', url: url('photo.png'), fileName: 'photo.png', mimeType: 'image/png', viewOnce: true, caption: 'selftest' } })
await check('video view once', 'send_media', { to, media: { type: 'video', url: url('video.mov'), fileName: 'video.mov', mimeType: 'video/quicktime', viewOnce: true } })
await check('reaction tray', 'react', { to, reaction: { emoji: '👍', text: reactText } }, () => !!reactText)

server.close()
await rm(photo, { force: true })
await rm(video, { force: true })
const report = { at: new Date().toISOString(), from, to, ok: checks.every(item => item.ok), checks }
await writeFile(path.join(dir, `${report.at.slice(0, 10)}.json`), JSON.stringify(report, null, 2))
await writeFile(path.join(dir, 'latest.json'), JSON.stringify(report, null, 2))
for (const item of checks) {
  console.log(`${item.ok ? (item.skipped ? 'SKIP' : 'OK  ') : 'FAIL'} ${item.name} (${item.seconds}s)${item.step ? ` at ${item.step}` : ''}${item.error ? `: ${item.error}` : ''}`)
}
log[report.ok ? 'info' : 'error']({ report }, report.ok ? 'Phone gateway self-test passed' : 'Phone gateway self-test FAILED')
process.exit(report.ok ? 0 : 1)
