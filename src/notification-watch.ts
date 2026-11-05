import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { config } from './config.js'
import { log } from './logger.js'

/**
 * Contract: PGW-42 — the phone's system log, filtered on the phone to the NotificationManager tag, tells the
 * gateway the moment WhatsApp posts a notification ("com.whatsapp.w4b: notify(…"). That is the cue to read
 * the notifications at once instead of waiting for the next poll. The stream is restarted whenever it ends
 * (an ADB reconnect, a phone restart); the poll stays as the fallback, so a dead stream only costs speed.
 */

const WHATSAPP_NOTIFY = /\bcom\.whatsapp(?:\.w4b)?: notify\(/
const RESTART_AFTER_MS = 5_000

export function isWhatsAppNotify(line: string): boolean {
  return WHATSAPP_NOTIFY.test(line)
}

export function watchNotifications(serial: string, onNotify: () => void): () => void {
  let child: ChildProcess | undefined
  let stopped = false
  let restarts = 0
  const start = () => {
    if (stopped) return
    // `-T 1` starts at the newest line, so an old notification in the buffer is not replayed.
    child = spawn(config.adbPath, ['-s', serial, 'logcat', '-v', 'brief', '-T', '1', 'NotificationManager:I', '*:S'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', line => {
      restarts = 0
      if (isWhatsAppNotify(line)) onNotify()
    })
    child.on('close', () => {
      lines.close()
      if (stopped) return
      // Log the first drop of a run only; an offline phone is reported by the watchdog (PGW-18).
      if (restarts++ === 0) log.warn({ serial }, 'Notification stream ended; restarting it')
      setTimeout(start, RESTART_AFTER_MS).unref?.()
    })
    child.on('error', () => undefined)
  }
  start()
  return () => {
    stopped = true
    child?.kill()
  }
}
