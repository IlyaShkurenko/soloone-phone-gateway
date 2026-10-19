import { screenshot, shell, sleep, topActivity } from './adb.js'
import { config } from './config.js'
import { askJson, llmAvailable } from './llm.js'
import { log } from './logger.js'
import { recoveryTapRefusal } from './safety.js'
import { describeTree, tap, type Selector, type UiNode } from './ui.js'

export interface RecoveryAction {
  action: 'tap' | 'back' | 'wait' | 'abort'
  index?: number
  reason?: string
  node?: string
}

const SYSTEM = `You help a fixed automation script that drives the official WhatsApp app on an Android phone.
The script is stuck: the element it expects is not on screen. Choose ONE safe action that brings the screen
closer to the step goal, for example closing a popup, dismissing a tooltip or going back from a wrong screen.
You must never send, record, call, delete, block, or open another chat. Those taps are refused anyway.
Reply with JSON only: {"action":"tap","index":<node number>,"reason":"..."} or {"action":"back","reason":"..."}
or {"action":"wait","reason":"..."} or {"action":"abort","reason":"..."} when nothing safe would help.`

// Contract: PGW-6 — one validated action per call; the caller re-reads the screen afterwards.
export async function recoverOnce(serial: string, input: {
  goal: string
  selector?: Selector
  nodes: UiNode[]
}): Promise<RecoveryAction | null> {
  if (!llmAvailable(config.llm.recoveryModel)) return null
  const [image, activity] = await Promise.all([
    screenshot(serial).catch(() => undefined),
    topActivity(serial).catch(() => 'unknown')
  ])
  const text = [
    `Step goal: ${input.goal}`,
    `Expected element: ${JSON.stringify(input.selector || {})}`,
    `Current activity: ${activity}`,
    'Screen elements:',
    describeTree(input.nodes)
  ].join('\n')

  let reply: RecoveryAction
  try {
    reply = await askJson(config.llm.recoveryModel, SYSTEM, text, image) as RecoveryAction
  } catch (error) {
    log.warn({ err: error }, 'Recovery model call failed')
    return { action: 'abort', reason: 'recovery model unavailable' }
  }

  if (reply.action === 'tap') {
    const node = input.nodes.find(item => item.index === reply.index)
    const refusal = node ? recoveryTapRefusal(node, input.nodes) : 'node does not exist'
    if (refusal || !node) {
      log.warn({ index: reply.index, refusal }, 'Recovery tap refused')
      return { action: 'abort', reason: `refused tap: ${refusal}` }
    }
    await tap(serial, node)
    await sleep(800)
    return { ...reply, node: describeTree([node]) }
  }
  if (reply.action === 'back') {
    await shell(serial, 'input keyevent KEYCODE_BACK')
    await sleep(800)
    return reply
  }
  if (reply.action === 'wait') {
    await sleep(2000)
    return reply
  }
  return { action: 'abort', reason: reply.reason || 'model aborted' }
}
