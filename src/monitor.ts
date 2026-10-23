// Contract: PGW-18 — physical phones are checked on a timer; the operator gets an email when one
// stops answering over ADB, when it comes back, and when its battery runs low off the charger.
import { readFile } from 'node:fs/promises'
import { adb, shell } from './adb.js'
import { config } from './config.js'
import { log } from './logger.js'

interface PhysicalDevice { phone: string; adbAddress: string }
interface State { failures: number; down: boolean; lowBatteryWarned: boolean }

const states = new Map<string, State>()

async function physicalDevices(): Promise<PhysicalDevice[]> {
  const raw = JSON.parse(await readFile(config.devicesFile, 'utf8')) as Record<string, unknown>[]
  return raw.filter(item => item.driver === 'physical' && typeof item.adbAddress === 'string')
    .map(item => ({ phone: String(item.phone), adbAddress: String(item.adbAddress) }))
}

async function sendEmail(subject: string, text: string): Promise<void> {
  const { resendApiKey, from, to } = config.alerts
  if (!resendApiKey || !to) {
    log.warn({ subject }, 'Alert email is not configured; alert only logged')
    return
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) log.error({ status: response.status, subject }, 'Alert email was not accepted')
  else log.info({ subject }, 'Alert email sent')
}

async function probe(device: PhysicalDevice): Promise<{ alive: boolean; battery?: number; charging?: boolean }> {
  try {
    await adb(['connect', device.adbAddress], 15_000).catch(() => undefined)
    if ((await shell(device.adbAddress, 'echo ok', 10