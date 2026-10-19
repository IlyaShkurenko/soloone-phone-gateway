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

export async function adb(args: string[], timeoutMs = 20_000): Promise<string> {
  return run(args, timeoutMs) as Promise<string>
}

// The command runs in the device shell, so callers quote untrusted parts with quote().
export async function shell(serial: string, command: string, timeoutMs = 20_000): Promise<string> {
  return adb(['-s', serial, 'shell', command], timeoutMs)
}

export async function screenshot(serial: string): Promise<Buffer> {
  return run(['-s', serial, 'exec-out', 'screencap', '-p'], 20_000, true) as Promise<Buffer>
}

export async function topActivity(serial: string): Promise<string> {
  const output = await shell(serial, 'dumpsys activity activities | grep -m1 topResumedActivity')
  return output.match(/\{[^}]*\s(\S+\/\S+)\s/)?.[1] || output.trim()
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
