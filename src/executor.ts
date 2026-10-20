import { quote, screenshot, shell, sleep, topActivity } from './adb.js'
import { config } from './config.js'
import { SendFailure, SendUncertain } from './errors.js'
import { stageMedia, type StagedMedia } from './media.js'
import { recoverOnce, type RecoveryAction } from './recovery.js'
import type { Script, Step } from './scripts.js'
import { clearFocusedInput, typeText } from './typing.js'
import { describeTree, dumpUi, find, findAll, longPress, sameEmoji, tap, type Selector, type UiNode } from './ui.js'

export interface RunRequest {
  messageId: string
  to: string
  pkg: string
  text?: string
  typingTimeMs?: number
  media?: { type: 'image' | 'video'; url: string; fileName: string; mimeType?: string; caption?: string; viewOnce: boolean }
  // An empty emoji removes `previousEmoji`, the way tapping your own reaction again does.
  reaction?: { emoji: string; previousEmoji?: string; text?: string; mediaType?: 'image' | 'video'; sentAt?: string }
}

export interface RunOptions {
  dryRun?: boolean
  startedAt: number
  onSendPressed: () => Promise<void>
}

export interface TraceEntry {
  step: number
  op: string
  note: string
  recovery?: RecoveryAction[]
}

export interface RunResult {
  outcome: 'sent' | 'stopped_before_send'
  trace: TraceEntry[]
}

// Evidence for the fixer: the screen where a step could not find its element.
export interface RunEvidence {
  step: number
  tree: string
  screenshot?: Buffer
}

export class RunError extends Error {
  constructor(
    public readonly failure: SendFailure | SendUncertain,
    public readonly trace: TraceEntry[],
    public readonly evidence?: RunEvidence
  ) {
    super(failure.message)
  }
}

const MAX_RECOVERY_PER_STEP = 3
const MAX_RECOVERY_PER_RUN = 6
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

export async function runScript(serial: string, script: Script, request: RunRequest, options: RunOptions): Promise<RunResult> {
  const trace: TraceEntry[] = []
  let evidence: RunEvidence | undefined
  let recoveriesLeft = MAX_RECOVERY_PER_RUN
  let sendPressed = false
  let chatHeader = ''
  let staged: StagedMedia | undefined
  let bubble: UiNode | undefined
  let reacted = false

  // Contract: PGW-6 — find an element, letting the recovery model act only before Send.
  async function locate(stepIndex: number, step: Step, selector: Selector, entry: TraceEntry): Promise<UiNode> {
    let nodes = await dumpUi(serial)
    let node = find(nodes, selector)
    for (let attempt = 0; !node && !sendPressed && attempt < MAX_RECOVERY_PER_STEP && recoveriesLeft > 0; attempt++) {
      if (!evidence) evidence = { step: stepIndex, tree: describeTree(nodes), screenshot: await screenshot(serial).catch(() => undefined) }
      recoveriesLeft--
      const action = await recoverOnce(serial, { goal: step.goal || step.op, selector, nodes })
      if (!action) break
      ;(entry.recovery ||= []).push(action)
      if (action.action === 'abort') break
      nodes = await dumpUi(serial)
      node = find(nodes, selector)
    }
    if (!node) {
      if (!evidence) evidence = { step: stepIndex, tree: describeTree(nodes), screenshot: await screenshot(serial).catch(() => undefined) }
      throw new SendFailure(`Step ${stepIndex} (${step.op}) could not find ${JSON.stringify(selector)}`, false)
    }
    return node
  }

  async function waitFor(selector: Selector, timeoutMs: number, stopOn?: Selector): Promise<UiNode[]> {
    const until = Date.now() + timeoutMs
    let nodes = await dumpUi(serial)
    while (Date.now() < until && !find(nodes, selector) && !(stopOn && find(nodes, stopOn))) {
      await sleep(800)
      nodes = await dumpUi(serial)
    }
    return nodes
  }

  const selectorParam = (step: Step, key: string): Selector => {
    const value = step[key] as Selector | undefined
    if (!value) throw new SendFailure(`Step ${step.op} is missing ${key}`, false)
    return value
  }

  try {
    await shell(serial, 'input keyevent KEYCODE_WAKEUP')
    for (const [index, step] of script.steps.entries()) {
      const entry: TraceEntry = { step: index, op: step.op, note: '' }
      trace.push(entry)
      if (Date.now() - options.startedAt > config.requestDeadlineMs) {
        throw sendPressed ? new SendUncertain('Ran out of time while confirming') : new SendFailure('Ran out of time before sending', true)
      }

      switch (step.op) {
        case 'open_chat': {
          if (request.media) throw new SendFailure('Text script used for media', false)
          await shell(serial, `am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${request.to}`)} -p ${quote(request.pkg)} >/dev/null`)
          const notOnWhatsapp = step.notOnWhatsapp as Selector | undefined
          const nodes = await waitFor(step.target!, 12_000, notOnWhatsapp)
          if (notOnWhatsapp && find(nodes, notOnWhatsapp)) throw new SendFailure('Recipient is not on WhatsApp', false)
          await locate(index, step, step.target!, entry)
          chatHeader = find(await dumpUi(serial), selectorParam(step, 'header'))?.text || ''
          if (!chatHeader) throw new SendFailure('Chat header is not readable', false)
          entry.note = 'chat opened'
          break
        }
        case 'share_media': {
          if (!request.media) throw new SendFailure('Media script used for text', false)
          staged = await stageMedia(serial, request.messageId, request.media)
          await shell(serial, [
            'am start -a android.intent.action.SEND',
            `-t ${quote(staged.mimeType)}`,
            `--eu android.intent.extra.STREAM ${quote(staged.contentUri)}`,
            `--es jid ${quote(`${request.to}@s.whatsapp.net`)}`,
            `--grant-read-uri-permission -p ${quote(request.pkg)} >/dev/null`
          ].join(' '))
          const shareDialog = step.shareDialog as Selector | undefined
          let nodes = await waitFor(step.target!, 15_000, shareDialog)
          if (shareDialog && find(nodes, shareDialog)) {
            // AICODE-NOTE: For a video sent to one chat WhatsApp first asks "Share with <name>?";
            // OK then opens the media composer (checked 2026-10-20). For photos OK may send at once,
            // so only videos pass this dialog, and only through this code path, never recovery.
            if (request.media.type !== 'video') throw new SendFailure('WhatsApp offered a plain file share for this photo', false)
            const confirm = find(nodes, selectorParam(step, 'shareConfirm'))
            if (!confirm) throw new SendFailure('Share dialog has no confirm button', false)
            await tap(serial, confirm)
            await sleep(1500)
            nodes = await waitFor(step.target!, 20_000)
          }
          await locate(index, step, step.target!, entry)
          entry.note = 'media composer opened'
          break
        }
        case 'tap': {
          await tap(serial, await locate(index, step, step.target!, entry))
          await sleep(600)
          entry.note = 'tapped'
          break
        }
        case 'dismiss_if_present': {
          const node = find(await dumpUi(serial), step.target!)
          if (node) {
            await tap(serial, node)
            await sleep(600)
          }
          entry.note = node ? 'dismissed' : 'not present'
          break
        }
        case 'wait': {
          await sleep(step.ms as number)
          break
        }
        case 'back': {
          await shell(serial, 'input keyevent KEYCODE_BACK')
          await sleep(600)
          break
        }
        case 'clear_input': {
          const emptyText = typeof step.emptyText === 'string' ? step.emptyText : ''
          const node = await locate(index, step, step.target!, entry)
          if (node.text && node.text !== emptyText) {
            await tap(serial, node)
            await clearFocusedInput(serial, Array.from(node.text).length)
            const after = find(await dumpUi(serial), step.target!)
            if (after?.text && after.text !== emptyText) throw new SendFailure('Could not clear the message input', true)
            entry.note = 'cleared a leftover draft'
          }
          break
        }
        case 'type_text': {
          if (!request.text) throw new SendFailure('Text is empty', false)
          await tap(serial, await locate(index, step, step.target!, entry))
          await typeText(serial, request.text, request.typingTimeMs || 2000)
          const typed = find(await dumpUi(serial), step.target!)
          if (normalize(typed?.text || '') !== normalize(request.text)) {
            if (typed?.text) await clearFocusedInput(serial, Array.from(typed.text).length)
            throw new SendFailure('Typed text does not match the message', true)
          }
          entry.note = 'typed and checked'
          break
        }
        case 'type_caption': {
          const caption = request.media?.caption?.trim()
          if (!caption) {
            entry.note = 'no caption'
            break
          }
          await tap(serial, await locate(index, step, step.target!, entry))
          await typeText(serial, caption, Math.min(8000, Array.from(caption).length * 80))
          const typed = findAll(await dumpUi(serial), step.target!).map(node => normalize(node.text))
          if (!typed.includes(normalize(caption))) throw new SendFailure('Typed caption does not match', true)
          entry.note = 'caption typed and checked'
          break
        }
        case 'ensure_view_once': {
          // Contract: PGW-9 — the toggle must end in the requested state before Send.
          const want = request.media?.viewOnce === true
          const onDesc = String(step.onDesc)
          let nodes = await dumpUi(serial)
          let toggle = find(nodes, step.target!)
          if (!toggle && !want) {
            entry.note = 'no toggle, View Once off'
            break
          }
          toggle ||= await locate(index, step, step.target!, entry)
          if ((toggle.desc === onDesc) !== want) {
            await tap(serial, toggle)
            await sleep(900)
            const nux = step.nux as Selector | undefined
            nodes = await dumpUi(serial)
            const sheet = nux && find(nodes, nux)
            if (sheet) {
              await tap(serial, sheet)
              await sleep(700)
            }
            nodes = await dumpUi(serial)
            toggle = find(nodes, step.target!)
          }
          if (!toggle || (toggle.desc === onDesc) !== want) throw new SendFailure('View Once state could not be confirmed', false)
          entry.note = want ? 'View Once on' : 'View Once off'
          break
        }
        case 'check_recipient': {
          // Contract: PGW-9 — only the chat opened for `to`, or exactly one share recipient.
          const nodes = await dumpUi(serial)
          if (request.media) {
            const recipients = find(nodes, selectorParam(step, 'recipients'))
            if (!recipients) throw new SendFailure('Share recipient count is not visible', false)
          } else {
            const activity = await topActivity(serial)
            if (!activity.includes(String(step.activity || 'Conversation'))) throw new SendFailure('WhatsApp left the chat before sending', false)
            if (find(nodes, selectorParam(step, 'header'))?.text !== chatHeader) throw new SendFailure('The open chat changed before sending', false)
          }
          entry.note = 'recipient checked'
          break
        }
        case 'send': {
          if (options.dryRun) {
            entry.note = 'dry run stopped before Send'
            await discardDraft(serial, script, request)
            return { outcome: 'stopped_before_send', trace }
          }
          if (Date.now() - options.startedAt > config.latestSendStartMs) throw new SendFailure('Too late to start sending safely', true)
          const button = await locate(index, step, step.target!, entry)
          await options.onSendPressed()
          sendPressed = true
          await tap(serial, button)
          entry.note = 'Send pressed'
          break
        }
        case 'find_message': {
          if (!request.reaction) throw new SendFailure('Reaction script used without a reaction', false)
          bubble = await findTargetBubble(serial, step, request.reaction)
          if (!bubble) throw new SendFailure('The message to react to is not visible in the chat', false)
          entry.note = 'message found'
          break
        }
        case 'open_reactions': {
          if (!bubble) throw new SendFailure('No message selected for the reaction', false)
          await longPress(serial, bubble)
          await sleep(1200)
          if (!find(await dumpUi(serial, true), selectorParam(step, 'tray'))) {
            await shell(serial, 'input keyevent KEYCODE_BACK')
            throw new SendFailure('Reaction tray did not open', true)
          }
          entry.note = 'reaction tray open'
          break
        }
        case 'choose_reaction': {
          // Contract: PGW-12 — the reaction is the irreversible action; it is recorded first like Send.
          const emoji = request.reaction?.emoji || request.reaction?.previousEmoji
          if (!emoji) throw new SendFailure('No reaction to set or remove', false)
          const option = await findReactionOption(serial, step, emoji)
          if (!option) {
            for (let attempt = 0; attempt < 3; attempt++) await shell(serial, 'input keyevent KEYCODE_BACK')
            throw new SendFailure(`Reaction ${emoji} is not available on the phone`, false)
          }
          await options.onSendPressed()
          sendPressed = true
          await tap(serial, option)
          await sleep(1200)
          entry.note = request.reaction?.emoji ? 'reaction chosen' : 'reaction removed'
          break
        }
        case 'confirm_reaction': {
          if (!sendPressed || !request.reaction) throw new SendFailure('Script confirms before reacting', false)
          await confirmReaction(serial, step, request.reaction)
          reacted = true
          entry.note = 'reaction confirmed'
          break
        }
        case 'confirm_sent': {
          if (!sendPressed) throw new SendFailure('Script confirms before Send', false)
          await confirmSent(serial, step, request, options.startedAt + config.requestDeadlineMs)
          entry.note = 'sent bubble confirmed'
          break
        }
      }
    }
    if (!sendPressed || (request.reaction && !reacted)) throw new SendFailure('Script finished without sending', false)
    return { outcome: 'sent', trace }
  } catch (error) {
    const cause = error instanceof SendFailure || error instanceof SendUncertain
      ? error
      : sendPressed
        ? new SendUncertain(error instanceof Error ? error.message : 'Confirmation failed')
        : new SendFailure(error instanceof Error ? error.message : 'Phone operation failed', true)
    // An error after Send can never be reported as a safe failure.
    throw new RunError(sendPressed && cause instanceof SendFailure ? new SendUncertain(cause.message) : cause, trace, evidence)
  } finally {
    await staged?.cleanup()
    // Contract: PGW-11 — an open chat would mark new incoming messages as read.
    await shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined)
  }
}

async function confirmSent(serial: string, step: Step, request: RunRequest, deadline: number): Promise<void> {
  const okStatus = Array.isArray(step.okStatus) ? step.okStatus.map(String) : ['Sent', 'Delivered', 'Read']
  const status = step.status as Selector
  // Never wait past the request deadline; the backend would time out first.
  const until = Math.min(deadline, Date.now() + (typeof step.timeoutMs === 'number' ? step.timeoutMs : 30_000))
  while (Date.now() < until) {
    const nodes = await dumpUi(serial)
    const activity = await topActivity(serial)
    if (activity.includes(String(step.activity || 'Conversation'))) {
      const bubbleSelector = (request.media ? step.mediaBubble : step.textBubble) as Selector
      let bubbles = findAll(nodes, bubbleSelector)
      if (!request.media) bubbles = bubbles.filter(node => normalize(node.text) === normalize(request.text || ''))
      const bubble = bubbles.sort((a, b) => b.bounds[3] - a.bounds[3])[0]
      const input = step.input as Selector | undefined
      const inputNode = input && find(nodes, input)
      const inputEmpty = request.media || !inputNode || !inputNode.text || inputNode.text === step.emptyText
      if (bubble && inputEmpty) {
        // The status ticks sit inside the same row, at or slightly below the bubble content.
        const ticks = findAll(nodes, status).find(node => node.bounds[1] >= bubble.bounds[1] - 20 && node.bounds[1] <= bubble.bounds[3] + 160)
        if (ticks && okStatus.includes(ticks.desc)) return
      }
    }
    await sleep(1200)
  }
  throw new SendUncertain('Send was pressed but the sent bubble was not confirmed')
}

async function discardDraft(serial: string, script: Script, request: RunRequest): Promise<void> {
  if (request.media) {
    for (let attempt = 0; attempt < 3 && /mediacomposer/i.test(await topActivity(serial)); attempt++) {
      await shell(serial, 'input keyevent KEYCODE_BACK')
      await sleep(700)
    }
    return
  }
  const input = script.steps.find(step => step.op === 'type_text')?.target
  const node = input && find(await dumpUi(serial), input)
  if (node?.text) {
    await tap(serial, node)
    await clearFocusedInput(serial, Array.from(node.text).length)
  }
}

function phoneTimeLabel(iso: string, timeZone: string): string | undefined {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return undefined
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(date)
  } catch {
    return undefined
  }
}

// Rows keep the time label and ticks a little below the bubble content.
const sameRow = (node: UiNode, bubble: UiNode) => node.bounds[1] >= bubble.bounds[1] - 20 && node.bounds[1] <= bubble.bounds[3] + 160

function bubbleCandidates(nodes: UiNode[], step: Step, reaction: NonNullable<RunRequest['reaction']>): UiNode[] {
  if (reaction.text) {
    return findAll(nodes, step.textBubble as Selector).filter(node => normalize(node.text) === normalize(reaction.text!))
  }
  const kind = reaction.mediaType === 'video' ? /video/i : /photo/i
  return findAll(nodes, step.mediaBubble as Selector).filter(node => kind.test(node.desc))
}

// Contract: PGW-12 — newest matching bubble, preferring the one sent at the backend's time.
async function findTargetBubble(serial: string, step: Step, reaction: NonNullable<RunRequest['reaction']>): Promise<UiNode | undefined> {
  const timeZone = (await shell(serial, 'getprop persist.sys.timezone')).trim()
  const label = reaction.sentAt && timeZone ? phoneTimeLabel(reaction.sentAt, timeZone) : undefined
  const maxScrolls = typeof step.maxScrolls === 'number' ? step.maxScrolls : 4
  let firstScreen: UiNode[] = []
  for (let scroll = 0; scroll <= maxScrolls; scroll++) {
    const nodes = await dumpUi(serial)
    const candidates = bubbleCandidates(nodes, step, reaction).sort((a, b) => b.bounds[3] - a.bounds[3])
    if (!label) {
      if (candidates.length) return candidates[0]
    } else {
      const dates = findAll(nodes, step.date as Selector)
      const timed = candidates.find(node => dates.some(date => date.text === label && sameRow(date, node)))
      if (timed) return timed
      if (scroll === 0) firstScreen = candidates
    }
    if (scroll < maxScrolls) {
      await shell(serial, 'input swipe 632 900 632 1900 350')
      await sleep(900)
    }
  }
  // Scrolling moved the screen; return to the newest messages before using the fallback.
  if (label && firstScreen.length === 1) {
    for (let scroll = 0; scroll < maxScrolls; scroll++) await shell(serial, 'input swipe 632 1900 632 900 350')
    await sleep(900)
    return bubbleCandidates(await dumpUi(serial), step, reaction).sort((a, b) => b.bounds[3] - a.bounds[3])[0]
  }
  return undefined
}

async function findReactionOption(serial: string, step: Step, emoji: string): Promise<UiNode | undefined> {
  let nodes = await dumpUi(serial, true)
  const tray = find(nodes, step.tray as Selector)
  const inTray = tray && nodes.find(node => node.clickable && sameEmoji(node.text, emoji)
    && node.bounds[1] >= tray.bounds[1] - 40 && node.bounds[3] <= tray.bounds[3] + 40)
  if (inTray) return inTray

  const more = find(nodes, step.more as Selector)
  if (!more) return undefined
  await tap(serial, more)
  await sleep(1300)
  nodes = await dumpUi(serial, true)
  const inGrid = findAll(nodes, step.pickerEmoji as Selector).find(node => sameEmoji(node.desc, emoji))
  if (inGrid) return inGrid

  const keywords = (step.keywords || {}) as Record<string, string>
  const keyword = Object.entries(keywords).find(([key]) => sameEmoji(key, emoji))?.[1]
  const search = find(nodes, step.search as Selector)
  if (!keyword || !search) return undefined
  await tap(serial, search)
  await sleep(900)
  await typeText(serial, keyword, 600)
  await sleep(1500)
  return findAll(await dumpUi(serial, true), step.pickerEmoji as Selector).find(node => sameEmoji(node.desc, emoji))
}

async function confirmReaction(serial: string, step: Step, reaction: NonNullable<RunRequest['reaction']>): Promise<void> {
  const until = Date.now() + 8000
  while (Date.now() < until) {
    const nodes = await dumpUi(serial)
    const target = bubbleCandidates(nodes, step, reaction).sort((a, b) => b.bounds[3] - a.bounds[3])[0]
    if (target) {
      const bubbleIds = new Set(findAll(nodes, step.textBubble as Selector).map(node => node.index))
      const chip = findAll(nodes, step.reactionChip as Selector).filter(node => !bubbleIds.has(node.index) && sameRow(node, target))
      const wanted = (reaction.emoji || reaction.previousEmoji || '').replace(/\uFE0F/g, '')
      const shows = chip.some(node => (node.desc + node.text).replace(/\uFE0F/g, '').includes(wanted))
      if (reaction.emoji ? shows : !shows) return
    }
    await sleep(1000)
  }
  throw new SendUncertain('The reaction was tapped but its result was not confirmed')
}
