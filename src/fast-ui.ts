import { access } from 'node:fs/promises'
import { adb, shell, sleep } from './adb.js'
import { config } from './config.js'
import { log } from './logger.js'

// Contract: PGW-36 — a resident uiautomator2 server reads the screen in well under a second, where every
// `uiautomator dump` starts a new process and takes 3-4 s on these phones. Only for the serials listed in
// FAST_UI_SERIALS; any failure falls back to the plain dump.
// AICODE-NOTE: Android allows one UiAutomation client at a time. While the server runs, `uiautomator dump`
// fails, so the fallback stops the server first and the next fast read starts it again.

const DEVICE_PORT = 9008
const RETRY_AFTER_MS = 60_000
const ports = new Map<string, number>()
const brokenUntil = new Map<string, number>()

export function fastUiEnabled(serial: string): boolean {
  return config.fastUi.serials.includes(serial) && (brokenUntil.get(serial) || 0) < Date.now()
}

async function ping(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2000) })
    return (await response.text()).includes('pong')
  } catch {
    return false
  }
}

async function ensureServer(serial: string): Promise<number> {
  let port = ports.get(serial)
  if (port && await ping(port)) return port
  // A dropped ADB link loses its forwards, so the forward is made again each time the server is not answering.
  port = parseInt((await adb(['-s', serial, 'forward', 'tcp:0', `tcp:${DEVICE_PORT}`])).trim(), 10)
  if (!port) throw new Error('No local port for the UI server')
  ports.set(serial, port)
  if (await ping(port)) return port
  if (!(await shell(serial, 'ls /data/local/tmp/u2.jar 2>/dev/null')).includes('u2.jar')) {
    await access(config.fastUi.jarPath)
    await adb(['-s', serial, 'push', config.fastUi.jarPath, '/data/local/tmp/u2.jar'], 60_000)
  }
  await shell(serial, `nohup sh -c "CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p ${DEVICE_PORT}" >/dev/null 2>&1 &`)
  for (let waited = 0; waited < 15_000; waited += 500) {
    if (await ping(port)) return port
    await sleep(500)
  }
  throw new Error('UI server did not start')
}

// The same XML as `uiautomator dump`, all windows included.
export async function fastDump(serial: string): Promise<string> {
  const port = await ensureServer(serial)
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc/0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [false, 50] }),
    signal: AbortSignal.timeout(15_000)
  })
  const body = await response.json() as { result?: unknown; error?: unknown }
  if (typeof body.result !== 'string' || !body.result.includes('<hierarchy')) throw new Error('UI server returned no tree')
  return body.result
}

export async function stopFastUi(serial: string, error: unknown): Promise<void> {
  log.warn({ err: error, serial }, 'Fast UI read failed; using the plain dump for a while')
  brokenUntil.set(serial, Date.now() + RETRY_AFTER_MS)
  ports.delete(serial)
  await shell(serial, 'pkill -f com.wetest.uia2.Main').catch(() => undefined)
}
