// Contract: PGW-20 — every failed or uncertain send leaves a report on disk for later investigation.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import type { FailureScreen, TraceEntry } from './executor.js'
import { log } from './logger.js'

const KEEP_DAYS = 14

export interface FailureReport {
  messageId: string
  outcome: 'failed' | 'unknown'
  error: string
  retryable?: boolean
  request: unknown
  trace?: TraceEntry[]
  screen?: FailureScreen
}

async function pruneOld(dir: string): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const name of await readdir(dir)) {
    const folder = path.join(dir, name)
    if ((await stat(folder)).mtimeMs < cutoff) await rm(folder, { recursive: true, force: true })
  }
}

export async function saveFailure(report: FailureReport): Promise<void> {
  try {
    const dir = path.join(config.stateDir, 'failures')
    const folder = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${report.messageId}`)
    await mkdir(folder, { recursive: true })
    const { screen, ...rest } = report
    await writeFile(path.join(folder, 'failure.json'), JSON.stringify({ ...rest, savedAt: new Date().toISOString(), activity: screen?.activity }, null, 2))
    if (screen?.tree) await writeFile(path.join(folder, 'tree.txt'), screen.tree)
    if (screen?.screenshot) await writeFile(path.join(folder, 'screen.png'), screen.screenshot)
    await pruneOld(dir)
  } catch (error) {
    log.warn({ err: error, messageId: report.messageId }, 'Failure report was not saved')
  }
}
