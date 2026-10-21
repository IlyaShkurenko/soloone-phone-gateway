import { execFile } from 'node:child_process'
import { config } from './config.js'

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function run(args: string[], timeoutMs: number, binary = false): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr?.toString() || stdout?.toString() || error.message).trim()
        reject(new Error(`adb ${args.slice(0, 4).join(' ')} failed: ${detail.slice(0, 300)}`))
        return
      }
      resolve(stdout)
    })
  })
}

const DROPPED = /device offline|device '[^']*' not found|connection reset|closed|protocol fault/i

// Contract: PGW-17 — a dropped TCP ADB link (VPN hiccup) is reconnected once and the command retried.
async function withReconnect<T>(args: string[], attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    const serialIndex = args.indexOf('-s')
    const serial = serialIndex >= 0 ? args[serialIndex + 1] : undefined
    if (!serial || !serial.includes(':') || !DROPPED.test(error instanceof Error ? error.message : String(error))) throw error
    await run(['disconnect', serial], 10_000).catch(() => undefined)
    await run(['connect', serial], 15_000)
    await sleep(1500)
    return attempt()
  }
}

export async function adb(args: string[], timeoutMs = 20_000): Promise<string> {
  return withReconnect(args, () => run(args, timeoutMs) as Promise<string>)
}

// The command runs in the device shell, so callers quote untrusted parts with quote().
export async function shell(serial: string, command: string, timeoutMs = 20_000): Promise<string> {
  return adb(['-s', serial, 'shell', command], timeoutMs)
}

export async function screenshot(serial: string): Promise<Buffer> {
  const args = ['-s', serial, 'exec-out', 'screencap', '-p']
  return withReconnect(args, () => run(args, 20_000, true) as Promise<Buffer>)
}

export async function topActivity(serial: string): Promise<string> {
  const output = await shell(serial, 'dumpsys activity activities | grep -m1 topResumedActivity')
  return output.match(/\{[^}]*\s(\S+\/\S+)\s/)?.[1] || output.trim()
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
