import { execFile } from 'node:child_process'
import { config } from '../config.js'
import { adb, shell, sleep } from '../adb.js'
import { SendFailure } from '../errors.js'
import { log } from '../logger.js'

interface ApiResponse<T> {
  status?: { http_code?: number; message?: string; error_code?: string }
  data?: T
}

const STOPPED = 2
const STARTED = 0
const STARTING = 1
const EXPIRED = 3
const idleTimers = new Map<string, NodeJS.Timeout>()

async function api<T>(path: string, body: unknown): Promise<T> {
  if (!config.multilogin.token) throw new SendFailure('Multilogin token is not configured', false)
  const response = await fetch(`${config.multilogin.apiUrl}${path}`, {
    method: 'POST',
    // Cloudflare in front of the API rejects some default client signatures.
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': 'soloone-phone-gateway/1.0', Authorization: `Bearer ${config.multilogin.token}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  })
  const json = await response.json().catch(() => null) as ApiResponse<T> | null
  if (response.status === 401 || response.status === 403) throw new SendFailure('Multilogin token was rejected', false)
  if (!response.ok || !json?.data) throw new SendFailure(`Multilogin ${path} failed (HTTP ${response.status})`, true)
  return json.data
}

// Without an automation token, a logged-in xcli on the same host performs the same calls.
// xcli keeps its session encrypted, so the gateway never reads that token itself.
function xcli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.multilogin.xcliPath, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new SendFailure(`xcli ${args[0]} failed: ${(stderr || stdout || error.message).trim().slice(0, 200)}`, true))
      else resolve(stdout)
    })
  })
}

const field = (output: string, name: string) => output.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'mi'))?.[1]?.trim()
const useXcli = () => !config.multilogin.token

async function phoneStatus(profileId: string): Promise<number | undefined> {
  if (useXcli()) {
    const status = field(await xcli(['mobile-profiles-statuses', '--ids', profileId]), 'Status')
    return status === undefined ? undefined : Number(status)
  }
  const data = await api<{ success_details?: { id: string; status: number }[] }>('/mobile_profiles/phone/statuses', { ids: [profileId] })
  return data.success_details?.find(item => item.id === profileId)?.status
}

async function startPhone(profileId: string): Promise<void> {
  if (useXcli()) {
    const output = await xcli(['mobile-profiles-phone-start', '--ids', profileId])
    if (!/Success:\s*1/.test(output)) throw new SendFailure('Cloud phone start was not accepted', true)
    return
  }
  await api('/mobile_profiles/phone/start', { ids: [profileId] })
}

async function ensureStarted(profileId: string): Promise<void> {
  let status = await phoneStatus(profileId)
  if (status === undefined) throw new SendFailure('Cloud phone profile was not found', false)
  if (status === EXPIRED) throw new SendFailure('Cloud phone subscription has expired', false)
  if (status === STOPPED) {
    log.info({ profileId }, 'Starting stopped cloud phone')
    try {
      await startPhone(profileId)
    } catch (error) {
      // Multilogin can answer start with HTTP 500 while the phone does start; trust the status.
      await sleep(3000)
      status = await phoneStatus(profileId)
      if (status !== STARTED && status !== STARTING) throw error
      log.warn({ err: error, profileId, status }, 'Start reported an error, but the phone is starting')
    }
  }
  let waited = 0
  for (; status !== STARTED; waited += 3000) {
    if (waited > 90_000) throw new SendFailure('Cloud phone did not start in time', true)
    await sleep(3000)
    status = await phoneStatus(profileId)
  }
  // Right after a start the ADB service inside the phone needs a moment before it accepts logins.
  if (waited > 0) await sleep(12_000)
}

interface AdbInfo { id: string; status: string; ip?: string; port?: string; pwd?: string }

async function adbInfo(profileId: string): Promise<AdbInfo | undefined> {
  if (useXcli()) {
    const output = await xcli(['mobile-profiles-adb-info', '--ids', profileId])
    const status = field(output, 'Status')
    return status ? { id: profileId, status, ip: field(output, 'IP'), port: field(output, 'Port'), pwd: field(output, 'Pwd') } : undefined
  }
  const data = await api<{ items?: AdbInfo[] }>('/mobile_profiles/phone/adb/info', { ids: [profileId] })
  return data.items?.find(item => item.id === profileId)
}

async function setAdb(profileId: string, enabled: boolean): Promise<void> {
  if (useXcli()) {
    const output = await xcli(['mobile-profiles-adb-set', '--ids', profileId, enabled ? '--enable' : '--disable'])
    if (field(output, 'SuccessAmount') !== '1') throw new SendFailure('Cloud phone ADB toggle was not accepted', true)
    return
  }
  await api('/mobile_profiles/phone/adb/set', { ids: [profileId], enabled })
}

function scheduleIdleDisable(profileId: string, serial: string): void {
  clearTimeout(idleTimers.get(profileId))
  if (config.multilogin.adbIdleDisableMs <= 0) return
  idleTimers.set(profileId, setTimeout(() => {
    idleTimers.delete(profileId)
    adb(['disconnect', serial]).catch(() => undefined)
    setAdb(profileId, false).catch(error => log.warn({ err: error, profileId }, 'Could not disable idle ADB'))
  }, config.multilogin.adbIdleDisableMs))
}

async function isAlive(serial: string): Promise<boolean> {
  try {
    return (await shell(serial, 'echo ok', 8000)).trim() === 'ok'
  } catch {
    return false
  }
}

export async function connectMultilogin(profileId: string): Promise<string> {
  clearTimeout(idleTimers.get(profileId))
  await ensureStarted(profileId)

  let info = await adbInfo(profileId)
  if (info?.status !== 'active') {
    await setAdb(profileId, true)
    for (let waited = 0; info?.status !== 'active'; waited += 2000) {
      if (waited > 30_000) throw new SendFailure('Cloud phone ADB did not become active', true)
      await sleep(2000)
      info = await adbInfo(profileId)
    }
  }
  if (!info.ip || !info.port || !info.pwd) throw new SendFailure('Cloud phone ADB details are incomplete', true)

  const serial = `${info.ip}:${info.port}`
  if (!await isAlive(serial)) {
    await adb(['disconnect', serial]).catch(() => undefined)
    await adb(['connect', serial])
    // AICODE-NOTE: glogin is not a real shell command: the phone takes everything after "glogin"
    // as the password, so quotes or a "2>&1" make a correct password fail with "password error".
    if (!/^[A-Za-z0-9]+$/.test(info.pwd)) throw new SendFailure('Cloud phone ADB password has unexpected characters', true)
    // Right after ADB is enabled the phone may not accept logins for a few seconds.
    let login = ''
    for (let attempt = 0; attempt < 12 && !/success|already logged/i.test(login); attempt++) {
      if (attempt > 0) await sleep(4000)
      login = await adb(['-s', serial, 'shell', 'glogin', info.pwd]).catch(error => String(error))
    }
    if (!/success|already logged/i.test(login)) throw new SendFailure('Cloud phone ADB login failed', true)
    if (!await isAlive(serial)) throw new SendFailure('Cloud phone ADB is not responding', true)
  }
  return serial
}

export function releaseMultilogin(profileId: string, serial: string): void {
  scheduleIdleDisable(profileId, serial)
}
