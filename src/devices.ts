import { readFile } from 'node:fs/promises'
import { config } from './config.js'

export type Device =
  | { phone: string; driver: 'multilogin'; profileId: string; whatsappPackage?: string }
  | { phone: string; driver: 'physical'; adbAddress: string; whatsappPackage?: string }

function validate(value: unknown): Device {
  const device = value as Record<string, unknown>
  if (typeof device?.phone !== 'string' || !/^\d{7,15}$/.test(device.phone)) throw new Error('Device phone must be digits only')
  if (device.driver === 'multilogin' && typeof device.profileId === 'string' && device.profileId) return device as Device
  if (device.driver === 'physical' && typeof device.adbAddress === 'string' && /^[\w.-]+:\d+$/.test(device.adbAddress)) return device as Device
  throw new Error(`Device ${device.phone} has an unknown driver or missing connection details`)
}

// Read on every request so registry edits apply without a restart.
export async function findDevice(phone: string): Promise<Device | undefined> {
  const raw = JSON.parse(await readFile(config.devicesFile, 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error('Device registry must be a JSON array')
  return raw.map(validate).find(device => device.phone === phone)
}

export function whatsappPackage(device: Device): string {
  return device.whatsappPackage || 'com.whatsapp'
}
