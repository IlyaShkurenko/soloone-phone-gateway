import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

export type LedgerState = 'running' | 'failed' | 'sent' | 'unknown'

export interface LedgerEntry {
  messageId: string
  state: LedgerState
  pid: number
  sendPressedAt?: string
  error?: string
  updatedAt: string
}

const running = new Set<string>()

function entryPath(messageId: string): string {
  return path.join(config.stateDir, 'ledger', `${messageId}.json`)
}

async function read(messageId: string): Promise<LedgerEntry | undefined> {
  try {
    return JSON.parse(await readFile(entryPath(messageId), 'utf8')) as LedgerEntry
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

// fsync before returning: the record must survive a crash right after Send (PGW-3).
async function write(entry: LedgerEntry): Promise<void> {
  await mkdir(path.dirname(entryPath(entry.messageId)), { recursive: true })
  const file = await open(entryPath(entry.messageId), 'w')
  try {
    await file.writeFile(JSON.stringify(entry))
    await file.sync()
  } finally {
    await file.close()
  }
}

export type Admission =
  | { kind: 'start' }
  | { kind: 'done'; state: 'sent' | 'unknown'; error?: string }
  | { kind: 'in_progress' }

export async function admit(messageId: string): Promise<Admission> {
  if (running.has(messageId)) return { kind: 'in_progress' }
  const entry = await read(messageId)
  if (entry?.state === 'sent') return { kind: 'done', state: 'sent' }
  if (entry?.state === 'unknown') return { kind: 'done', state: 'unknown', error: entry.error }
  // A crash after Send leaves 'running' with sendPressedAt: treat it as uncertain.
  if (entry?.state === 'running' && entry.sendPressedAt) {
    await write({ ...entry, state: 'unknown', error: 'Gateway restarted after Send was pressed', updatedAt: new Date().toISOString() })
    return { kind: 'done', state: 'unknown', error: 'Gateway restarted after Send was pressed' }
  }
  running.add(messageId)
  await write({ messageId, state: 'running', pid: process.pid, updatedAt: new Date().toISOString() })
  return { kind: 'start' }
}

export async function markSendPressed(messageId: string): Promise<void> {
  await write({ messageId, state: 'running', pid: process.pid, sendPressedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
}

export async function finish(messageId: string, state: Exclude<LedgerState, 'running'>, error?: string): Promise<void> {
  const entry = await read(messageId)
  try {
    await write({
      messageId, state, pid: process.pid, sendPressedAt: entry?.sendPressedAt, error, updatedAt: new Date().toISOString()
    })
  } finally {
    running.delete(messageId)
  }
}
