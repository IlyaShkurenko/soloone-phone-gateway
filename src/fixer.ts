import { config } from './config.js'
import type { RunEvidence, TraceEntry } from './executor.js'
import { askJson, llmAvailable } from './llm.js'
import { log } from './logger.js'
import { GUARDED_OPS, FREE_OPS, saveProposal, validateScript, type Script } from './scripts.js'

const SYSTEM = `You maintain declarative JSON scripts that drive the official WhatsApp app on Android through its UI tree.
A script run needed help or failed because an element was not found. Propose a corrected full script.
Rules:
- Keep these guarded steps in exactly the same order: ${GUARDED_OPS.join(', ')}. You may change their selectors and parameters.
- You may add, remove or change only these free steps: ${FREE_OPS.join(', ')}.
- A selector is an object with any of: resourceId, text, textContains, desc, descContains, descPattern. All values are strings.
- Prefer stable resource IDs over visible text. Keep the script name.
Reply with JSON only: {"script": {...full script...}, "explanation": "what changed and why"}.`

// Contract: PGW-7 — store a validated proposal; activation always needs a person.
export async function proposeFix(input: {
  script: Script
  reason: string
  trace: TraceEntry[]
  evidence?: RunEvidence
}): Promise<void> {
  if (!llmAvailable(config.llm.fixerModel)) return
  const text = [
    `Reason: ${input.reason}`,
    'Current script:',
    JSON.stringify(input.script, null, 2),
    'Run trace (including recovery actions that were taken):',
    JSON.stringify(input.trace, null, 2),
    input.evidence ? `Screen where step ${input.evidence.step} could not find its element:\n${input.evidence.tree}` : 'No screen was captured.'
  ].join('\n\n')

  try {
    const reply = await askJson(config.llm.fixerModel, SYSTEM, text, input.evidence?.screenshot) as { script?: unknown; explanation?: unknown }
    const script = validateScript(reply.script, input.script)
    const proposal = await saveProposal({
      scriptName: input.script.name,
      baseVersion: input.script.version,
      reason: input.reason,
      explanation: typeof reply.explanation === 'string' ? reply.explanation : '',
      script
    })
    log.info({ proposalId: proposal.id, script: script.name }, 'Script fix proposed; waiting for approval')
  } catch (error) {
    log.warn({ err: error, script: input.script.name }, 'Script fix proposal was not usable')
  }
}
