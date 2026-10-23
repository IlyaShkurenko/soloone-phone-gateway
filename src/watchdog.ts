// Contract: PGW-18 — e-mail an alert when a physical phone stops answering over ADB, and again when it is back.
import { readFile } from 'node:fs/promises'
import { shell } from './adb.js'
import { config } from './config.js'
import type { Device } from './devices.js'
import { log } from './logger.js'

const CHECK_EVERY_MS = 5 * 60 * 1000
// Two misses in a row (about 10 minutes) before alerting, so a short Wi-Fi blip stays quiet.
const MISSES_BEFORE_ALERT = 2

interface State { misses: number; alerted: boolean; downSince?: string }
const states = new Map<string, State>()

async function sendEmail(subject: string, text: string): Promise<void> {
  if (!config.alerts.email || !config.alerts.resendApiKey) {
    log.warn({ subject }, 'Phone alert not e-mailed: ALERT_EMAIL or RESEND_API_KEY is not set')
    return
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.alerts.resendApiKey}` },
    body: JSON.stringify({ from: config.alerts.from, to: [config.alerts.email], subject, text }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) log.warn({ status: response.status, subject }, 'Phone alert e-mail was rejected')
}

async function alive(device: Extract<Device, { driver: 'physical' }>): Promise<boolean> {
  try {
    return (await shell(device.adbAddress, 'echo ok', 10_000)).trim() === 'ok'
  } catch {
    return false
  }
}

async function checkOnce(): Promise<void> {
  const devices = (JSON.parse(await readFile(config.devicesFile, 'utf8')) as Device[])
    .filter((device): device is Extract<Device, { driver: 'physical' }> => device.driver === 'physical')
  for (const device of devices) {
    const state = states.get(device.phone) || { misses: 0, alerted: false }
    if (await alive(device)) {
      if (state.alerted) {
        await sendEmail(`Phone +${device.phone} is back online`,
          `The phone +${device.phone} (${device.adbAddress}) answers over ADB again. It was offline since ${state.downSince}.\n\nMessages for this number go out through the phone again.`)
        log.info({ phone: device.phone }, 'Physical phone is back online')
      }
      states.set(device.phone, { misses: 0, alerted: false })
      continue
    }
    state.misses += 1
    state.downSince ||= new Date().toISOString()
    if (state.misses >= MISSES_BEFORE_ALERT && !state.alerted) {
      state.alerted = true
      await sendEmail(`Phone +${device.phone} is offline`, [
        `The phone +${device.phone} (${device.adbAddress}) has not answered over ADB since about ${state.downSince}.`,
        'Outgoing WhatsApp messages for this number will not be sent until it is back.',
        '',
        'Message for the person who has the phone:',
        '',
        'The phone is offline from our side. Please check:',
        '1. It is on the charger and switched on.',
        '2. It is connected to the home Wi-Fi.',
        '3. Settings → Developer options → Wireless debugging is ON. If it is off, turn it on and send me the IP address and port shown at the top of that screen.',
      ].join('\n'))
      log.warn({ phone: device.phone, downSince: state.downSince }, 'Physical phone is offline')
    }
    states.set(device.phone, state)
  }
}

export function startWatchdog(): void {
  const tick = () => { checkOnce().catch(error => log.warn({ err: error }, 'Phone watchdog check failed')) }
  setTimeout(tick, 60_000)
  setInterval(tick, CHECK_EVERY_MS)
}
