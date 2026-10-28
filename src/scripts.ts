import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import type { Selector } from './ui.js'

export const GUARDED_OPS = [
  'open_chat', 'share_media', 'clear_input', 'type_text', 'type_caption',
  'ensure_view_once', 'check_recipient', 'send', 'confirm_sent',
  'find_message', 'open_reactions', 'choose_reaction', 'confirm_reaction',
  'delete_for_everyone', 'confirm_deleted', 'open_edit', 'confirm_edited'
] as const
export const FREE_OPS = ['tap', 'dismiss_if_present', 'wait', 'back'] as const
const KNOWN_OPS = new Set<string>([...GUARDED_OPS, ...FREE_OPS])
const SELECTOR_KEYS = new Set(['resourceId', 'text', 'textContains', 'desc', 'descContains', 'descPattern'])

export interface Step {
  op: string
  goal?: string
  target?: Selector
  [param: string]: unknown
}

export interface Script {
  name: string
  version: number
  steps: Step[]
}

export interface Proposal {
  id: string
  scriptName: string
  baseVersion: number
  createdAt: string
  reason: string
  explanation: string
  script: Script
}

function isSelector(value: unknown): value is Selector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([key, item]) => SELECTOR_KEYS.has(key) && typeof item === 'string')
}

const guardedSequence = (script: Script) => script.steps.map(step => step.op).filter(op => (GUARDED_OPS as readonly string[]).includes(op))

// Contract: PGW-5/PGW-7 — a script may change selectors and free steps, never the guarded order.
export function validateScript(candidate: unknown, base?: Script): Script {
  const script = candidate as Script
  if (!script || typeof script.name !== 'string' || !Array.isArray(script.steps) || script.steps.length === 0) {
    throw new Error('Script must have a name and steps')
  }
  for (const [index, step] of script.steps.entries()) {
    if (!step || typeof step.op !== 'string' || !KNOWN_OPS.has(step.op)) throw new Error(`Step ${index} has an unknown op`)
    for (const [key, value] of Object.entries(step)) {
      if (key === 'op' || key === 'goal') continue
      if (key === 'keywords') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(item => typeof item === 'string')) {
          throw new Error(`Step ${index} keywords must map emoji to search words`)
        }
        continue
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && !isSelector(value)) {
        throw new Error(`Step ${index} has an invalid selector in ${key}`)
      }
    }
    if (['tap', 'dismiss_if_present', 'send'].includes(step.op) && !isSelector(step.target)) {
      throw new Error(`Step ${index} (${step.op}) needs a target selector`)
    }
    if (step.op === 'wait' && !(typeof step.ms === 'number' && step.ms > 0 && step.ms <= 10_000)) {
      throw new Error(`Step ${index} wait must be 1-10000 ms`)
    }
  }
  if (base) {
    if (script.name !== base.name) throw new Error('A proposal cannot rename the script')
    if (guardedSequence(script).join(',') !== guardedSequence(base).join(',')) {
      throw new Error('A proposal must keep every guarded step in the same order')
    }
  }
  return { name: script.name, version: typeof script.version === 'number' ? script.version : 1, steps: script.steps }
}

export async function loadScript(name: string): Promise<Script> {
  const raw = JSON.parse(await readFile(path.join(config.scriptsDir, `${name}.json`), 'utf8')) as unknown
  return validateScript(raw)
}

const proposalsDir = () => path.join(config.stateDir, 'proposals')

export async function saveProposal(input: Omit<Proposal, 'id' | 'createdAt'>): Promise<Proposal> {
  const proposal: Proposal = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
  await mkdir(proposalsDir(), { recursive: true })
  await writeFile(path.join(proposalsDir(), `${proposal.id}.json`), JSON.stringify(proposal, null, 2))
  return proposal
}

export async function listProposals(): Promise<Proposal[]> {
  await mkdir(proposalsDir(), { recursive: true })
  const files = (await readdir(proposalsDir())).filter(file => file.endsWith('.json'))
  const proposals = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(proposalsDir(), file), 'utf8')) as Proposal))
  return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getProposal(id: string): Promise<Proposal | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined
  try {
    return JSON.parse(await readFile(path.join(proposalsDir(), `${id}.json`), 'utf8')) as Proposal
  } catch {
    return undefined
  }
}

// Approval is the only way a proposal becomes active (PGW-7). The previous script is kept.
export async function approveProposal(proposal: Proposal): Promise<Script> {
  const current = await loadScript(proposal.scriptName)
  if (current.version !== proposal.baseVersion) throw new Error('The script changed after this proposal was made')
  const next = validateScript({ ...proposal.script, version: current.version + 1 }, current)
  const historyDir = path.join(config.scriptsDir, 'history')
  await mkdir(historyDir, { recursive: true })
  await writeFile(path.join(historyDir, `${current.name}.v${current.version}.json`), JSON.stringify(current, null, 2))
  await writeFile(path.join(config.scriptsDir, `${next.name}.json`), JSON.stringify(next, null, 2))
  await rename(path.join(proposalsDir(), `${proposal.id}.json`), path.join(historyDir, `proposal-${proposal.id}.approved.json`))
  return next
}

export async function rejectProposal(proposal: Proposal): Promise<void> {
  const historyDir = path.join(config.scriptsDir, 'history')
  await mkdir(historyDir, { recursive: true })
  await rename(path.join(proposalsDir(), `${proposal.id}.json`), path.join(historyDir, `proposal-${proposal.id}.rejected.json`))
}
