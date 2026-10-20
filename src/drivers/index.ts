import { adb, shell } from '../adb.js'
import type { Device } from '../devices.js'
import { SendFailure } from '../errors.js'
import { connectMultilogin, releaseMultilogin, stopMultilogin } from './multilogin.js'

// A driver only provides a working ADB serial (PGW-4). Everything else is shared.
export async function connect(device: Device): Promise<string> {
  if (device.driver === 'multilogin') return connectMultilogin(device.profileId)

  const serial = device.adbAddress
  try {
    if ((await shell(serial, 'echo ok', 8000)).trim() === 'ok') return serial
  } catch {
    // Not connected yet.
  }
  try {
    await adb(['connect', serial])
    if ((await shell(serial, 'echo ok', 8000)).trim() === 'ok') return serial
  } catch {
    // Reported below.
  }
  throw new SendFailure('Phone is not reachable over ADB', true)
}

// A physical phone stays on; only a cloud phone can be stopped.
export async function stop(device: Device, serial: string): Promise<void> {
  if (device.driver === 'multilogin') await stopMultilogin(device.profileId, serial)
}

export function release(device: Device, serial: string): void {
  if (device.driver === 'multilogin') releaseMultilogin(device.profileId, serial)
}
