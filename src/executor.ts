import { quote, screenshot, shell, sleep, topActivity } from './adb.js'
import { config } from './config.js'
import { SendFailure, SendUncertain } from './errors.js'
import { discardPrepared, prepareMedia, stageMedia, type PreparedMedia, type StagedMedia } from './media.js'
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
  media?: {
    type: 'image' | 'video'; url: string; fileName: string; mimeType?: string; caption?: string; viewOnce: boolean
    // Started before the phone connection so download and conversion overlap with it.
    prepared?: Promise<PreparedMedia>
  }
  // An empty emoji removes `previousEmoji`, the way tapping your own reaction again does.
  reaction?: { emoji: string; previousEmoji?: string } & BubbleTarget
  // One of our own messages to delete for everyone (PGW-21).
  deletion?: BubbleTarget
}

export interface BubbleTarget { text?: string; mediaType?: 'image' | 'video'; sentAt?: string }

export interface RunOptions {
  dryRun?: boolean
  startedAt: number
  onSendPressed: () => Promise<void>
}

export interface TraceEntry {
  step: number
  op: string
  note: string
  // Milliseconds since the run started, when this step began.
  atMs?: number
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

// The screen at the moment a run failed, for the failure report (PGW-20).
export interface FailureScreen {
  activity?: string
  tree?: string
  screenshot?: Buffer
}

export class RunError extends Error {
  constructor(
    public readonly failure: SendFailure | SendUncertain,
    public readonly trace: TraceEntry[],
    public readonly evidence?: RunEvidence,
    public readonly screen?: FailureScreen
  ) {
    super(failure.message)
  }
}

const MAX_RECOVERY_PER_STEP = 3
const MAX_RECOVERY_PER_RUN = 6
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

export async function runScript(serial: string, script: Script, request: RunRequest, options: RunOptions): Promise<RunResult> {
  const trace: TraceEntry[] = []
  const runStartedAt = Date.now()
  let evidence: RunEvidence | undefined
  let recoveriesLeft = MAX_RECOVERY_PER_RUN
  let sendPressed = false
  let chatHeader = ''
  let staged: StagedMedia | undefined
  let bubble: UiNode | undefined
  let reacted = false
  let deleted = false
  let deletedBefore = 0

  // A UI snapshot stays valid for a few seconds while nothing is done on the phone (PGW-15).
  // Any action below clears it; checks after typing and after Send always read fresh.
  let cached: { nodes: UiNode[]; at: number } | null = null
  const read = async (fresh = false): Promise<UiNode[]> => {
    if (!fresh && cached && Date.now() - cached.at < config.uiSnapshotCacheMs) return cached.nodes
    const nodes = await dumpUi(serial)
    cached = { nodes, at: Date.now() }
    return nodes
  }
  const act = async <T>(promise: Promise<T>): Promise<T> => { const result = await promise; cached = null; return result }
  const tapNode = (node: UiNode) => act(tap(serial, node))
  const run = (command: string) => act(shell(serial, command))

  // Contract: PGW-6 — find an element, letting the recovery model act only before Send.
  async function locate(stepIndex: number, step: Step, selector: Selector, entry: TraceEntry): Promise<UiNode> {
    let nodes = await read()
    let node = find(nodes, selector)
    // AICODE-NOTE: Samsung system tips (e.g. Circle to Search) sit in their own window above WhatsApp and
    // hide its whole tree from the UI dump; Back closes them. Handled in code, before any model is asked.
    if (!node && nodes.some(item => /^com\.android\.systemui:id\/.*tip/i.test(item.resourceId))) {
      await run('input keyevent KEYCODE_BACK')
      await sleep(800)
      nodes = await read(true)
      node = find(nodes, selector)
      entry.note = 'closed a system tip'
    }
    for (let attempt = 0; !node && !sendPressed && attempt < MAX_RECOVERY_PER_STEP && recoveriesLeft > 0; attempt++) {
      if (!evidence) evidence = { step: stepIndex, tree: describeTree(nodes), screenshot: await screenshot(serial).catch(() => undefined) }
      recoveriesLeft--
      const action = await recoverOnce(serial, { goal: step.goal || step.op, selector, nodes })
      if (!action) break
      ;(entry.recovery ||= []).push(action)
      if (action.action === 'abort') break
      cached = null
      nodes = await read(true)
      node = find(nodes, selector)
    }
    if (!node) {
      if (!evidence) evidence = { step: stepIndex, tree: describeTree(nodes), screenshot: await screenshot(serial).catch(() => undefined) }
      throw new SendFailure(`Step ${stepIndex} (${step.op}) could not find ${JSON.stringify(selector)}`, false)
    }
    return node
  }

  async function waitFor(selector: Selector, timeoutMs: number, stopOn?: Selector, stopOn2?: Selector): Promise<UiNode[]> {
    const until = Date.now() + timeoutMs
    let nodes = await read(true)
    while (Date.now() < until && !find(nodes, selector) && !(stopOn && find(nodes, stopOn)) && !(stopOn2 && find(nodes, stopOn2))) {
      await sleep(800)
      nodes = await read(true)
    }
    return nodes
  }

  const selectorParam = (step: Step, key: string): Selector => {
    const value = step[key] as Selector | undefined
    if (!value) throw new SendFailure(`Step ${step.op} is missing ${key}`, false)
    return value
  }

  try {
    await run('input keyevent KEYCODE_WAKEUP')
    for (const [index, step] of script.steps.entries()) {
      const entry: TraceEntry = { step: index, op: step.op, note: '', atMs: Date.now() - runStartedAt }
      trace.push(entry)
      if (Date.now() - options.startedAt > config.requestDeadlineMs) {
        throw sendPressed ? new SendUncertain('Ran out of time while confirming') : new SendFailure('Ran out of time before sending', true)
      }

      switch (step.op) {
        case 'open_chat': {
          if (request.media) throw new SendFailure('Text script used for media', false)
          const notOnWhatsapp = step.notOnWhatsapp as Selector | undefined
          const retryDialog = step.retryDialog as Selector | undefined
          let nodes: UiNode[] = []
          for (let attempt = 0; attempt < 3; attempt++) {
            await run(`am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${request.to}`)} -p ${quote(request.pkg)} >/dev/null`)
            nodes = await waitFor(step.target!, 12_000, notOnWhatsapp, retryDialog)
            if (notOnWhatsapp && find(nodes, notOnWhatsapp)) throw new SendFailure('Recipient is not on WhatsApp', false)
            // AICODE-NOTE: WhatsApp Business sometimes answers the number lookup behind the deep link with
            // "Couldn't connect. Please try again later." although the phone is online; a retry usually works.
            const stuck = retryDialog && find(nodes, retryDialog)
            if (!stuck) break
            const ok = find(nodes, selectorParam(step, 'retryConfirm'))
            if (ok) await tapNode(ok)
            entry.note = `lookup retried (${attempt + 1})`
            await sleep(2500)
          }
          await locate(index, step, step.target!, entry)
          chatHeader = find(await read(), selectorParam(step, 'header'))?.text || ''
          if (!chatHeader) throw new SendFailure('Chat header is not readable', false)
          entry.note = 'chat opened'
          break
        }
        case 'share_media': {
          if (!request.media) throw new SendFailure('Media script used for text', false)
          const prepared = await (request.media.prepared ?? prepareMedia(request.messageId, request.media))
          staged = await stageMedia(serial, prepared)
          await run([
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
            await tapNode(confirm)
            await sleep(1500)
            nodes = await waitFor(step.target!, 20_000)
          }
          await locate(index, step, step.target!, entry)
          entry.note = 'media composer opened'
          break
        }
        case 'tap': {
          await tapNode(await locate(index, step, step.target!, entry))
          await sleep(600)
          entry.note = 'tapped'
          break
        }
        case 'dismiss_if_present': {
          const node = find(await read(), step.target!)
          if (node) {
            await tapNode(node)
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
          await run('input keyevent KEYCODE_BACK')
          await sleep(600)
          break
        }
        case 'clear_input': {
          const emptyText = typeof step.emptyText === 'string' ? step.emptyText : ''
          const node = await locate(index, step, step.target!, entry)
          if (node.text && node.text !== emptyText) {
            await tapNode(node)
            await act(clearFocusedInput(serial, Array.from(node.text).length))
            const after = find(await read(true), step.target!)
            if (after?.text && after.text !== emptyText) throw new SendFailure('Could not clear the message input', true)
            entry.note = 'cleared a leftover draft'
          }
          break
        }
        case 'type_text': {
          if (!request.text) throw new SendFailure('Text is empty', false)
          // AICODE-NOTE: the start of a message has been seen missing after typing (cause not reproduced),
          // so a mismatch is cleared and typed once more. Still before Send; a leftover fails the check again.
          const misses: string[] = []
          for (let attempt = 1; ; attempt++) {
            await tapNode(await locate(index, step, step.target!, entry))
            await act(typeText(serial, request.text, request.typingTimeMs ?? 0))
            const typed = find(await read(true), step.target!)
            if (normalize(typed?.text || '') === normalize(request.text)) break
            misses.push(`typed back ${JSON.stringify(typed?.text ?? null)}`)
            entry.note = misses.join('; ')
            if (typed?.text) await act(clearFocusedInput(serial, Array.from(typed.text).length))
            if (attempt === 2) throw new SendFailure('Typed text does not match the message', true)
          }
          entry.note = misses.length ? `${misses.join('; ')}; retyped and checked` : 'typed and checked'
          break
        }
        case 'type_caption': {
          const caption = request.media?.caption?.trim()
          if (!caption) {
            entry.note = 'no caption'
            break
          }
          await tapNode(await locate(index, step, step.target!, entry))
          await act(typeText(serial, caption))
          const typed = findAll(await read(true), step.target!).map(node => normalize(node.text))
          if (!typed.includes(normalize(caption))) throw new SendFailure('Typed caption does not match', true)
          entry.note = 'caption typed and checked'
          break
        }
        case 'ensure_view_once': {
          // Contract: PGW-9 — the toggle must end in the requested state before Send.
          const want = request.media?.viewOnce === true
          const onDesc = String(step.onDesc)
          let nodes = await read()
          let toggle = find(nodes, step.target!)
          if (!toggle && !want) {
            entry.note = 'no toggle, View Once off'
            break
          }
          toggle ||= await locate(index, step, step.target!, entry)
          if ((toggle.desc === onDesc) !== want) {
            await tapNode(toggle)
            await sleep(900)
            const nux = step.nux as Selector | undefined
            nodes = await read(true)
            const sheet = nux && find(nodes, nux)
            if (sheet) {
              await tapNode(sheet)
              await sleep(700)
            }
            nodes = await read(true)
            toggle = find(nodes, step.target!)
          }
          if (!toggle || (toggle.desc === onDesc) !== want) throw new SendFailure('View Once state could not be confirmed', false)
          entry.note = want ? 'View Once on' : 'View Once off'
          break
        }
        case 'check_recipient': {
          // Contract: PGW-9 — only the chat opened for `to`, or exactly one share recipient.
          const nodes = await read()
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
          await tapNode(button)
          entry.note = 'Send pressed'
          break
        }
        case 'find_message': {
          const target = request.reaction || request.deletion
          if (!target) throw new SendFailure('Script used without a target message', false)
          bubble = await findTargetBubble(serial, step, target)
          if (!bubble) throw new SendFailure('The target message is not visible in the chat', false)
          entry.note = 'message found'
          break
        }
        case 'open_reactions': {
          if (!bubble) throw new SendFailure('No message selected for the reaction', false)
          await act(longPress(serial, bubble))
          await sleep(1200)
          if (!find(await act(dumpUi(serial, true)), selectorParam(step, 'tray'))) {
            await run('input keyevent KEYCODE_BACK')
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
            for (let attempt = 0; attempt < 3; attempt++) await run('input keyevent KEYCODE_BACK')
            throw new SendFailure(`Reaction ${emoji} is not available on the phone`, false)
          }
          if (options.dryRun) {
            // The tray and the emoji were found; close them without reacting.
            entry.note = 'dry run stopped before choosing the reaction'
            for (let attempt = 0; attempt < 3; attempt++) await run('input keyevent KEYCODE_BACK')
            return { outcome: 'stopped_before_send', trace }
          }
          await options.onSendPressed()
          sendPressed = true
          await tapNode(option)
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
        case 'delete_for_everyone': {
          // Contract: PGW-21 — only "Delete for everyone" is ever tapped; the tap is recorded first like Send.
          if (!bubble || !request.deletion) throw new SendFailure('No message selected for deletion', false)
          deletedBefore = findAll(await read(true), selectorParam(step, 'deletedBubble')).length
          await act(longPress(serial, bubble))
          await sleep(1200)
          const menu = find(await read(true), selectorParam(step, 'deleteButton'))
          if (!menu) {
            await run('input keyevent KEYCODE_BACK')
            throw new SendFailure('Delete was not offered for this message', true)
          }
          await tapNode(menu)
          await sleep(1000)
          const dialog = await read(true)
          const forEveryone = find(dialog, selectorParam(step, 'forEveryone'))
          if (!forEveryone || options.dryRun) {
            const cancel = find(dialog, selectorParam(step, 'cancel'))
            await (cancel ? tapNode(cancel) : run('input keyevent KEYCODE_BACK'))
            await sleep(700)
            if (find(await read(true), selectorParam(step, 'selectionBar'))) await run('input keyevent KEYCODE_BACK')
            if (!forEveryone) throw new SendFailure('"Delete for everyone" is not offered: the message is too old or not ours', false)
            entry.note = 'dry run stopped before deleting'
            return { outcome: 'stopped_before_send', trace }
          }
          await options.onSendPressed()
          sendPressed = true
          await tapNode(forEveryone)
          entry.note = 'deleted for everyone'
          break
        }
        case 'confirm_deleted': {
          if (!sendPressed || !request.deletion) throw new SendFailure('Script confirms before deleting', false)
          const until = Date.now() + 10_000
          while (!deleted && Date.now() < until) {
            await sleep(1000)
            deleted = findAll(await read(true), selectorParam(step, 'deletedBubble')).length > deletedBefore
          }
          if (!deleted) throw new SendUncertain('Delete was tapped but the deleted placeholder did not appear')
          entry.note = 'deletion confirmed'
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
    if (!sendPressed || (request.reaction && !reacted) || (request.deletion && !deleted)) throw new SendFailure('Script finished without sending', false)
    return { outcome: 'sent', trace }
  } catch (error) {
    const cause = error instanceof SendFailure || error instanceof SendUncertain
      ? error
      : sendPressed
        ? new SendUncertain(error instanceof Error ? error.message : 'Confirmation failed')
        : new SendFailure(error instanceof Error ? error.message : 'Phone operation failed', true)
    // Captured before the finally block leaves the chat; a dead ADB link only loses the picture.
    const screen: FailureScreen = options.dryRun ? {} : {
      activity: await topActivity(serial).catch(() => undefined),
      tree: await dumpUi(serial).then(describeTree).catch(() => undefined),
      screenshot: await screenshot(serial).catch(() => undefined)
    }
    // An error after Send can never be reported as a safe failure.
    throw new RunError(sendPressed && cause instanceof SendFailure ? new SendUncertain(cause.message) : cause, trace, evidence, screen)
  } finally {
    if (!staged && request.media?.prepared) await request.media.prepared.then(discardPrepared).catch(() => undefined)
    await staged?.cleanup()
    // Contract: PGW-11 — an open chat would mark new incoming messages as read.
    await run('input keyevent KEYCODE_HOME').catch(() => undefined)
  }
}

async function confirmSent(serial: string, step: Step, request: RunRequest, deadline: number): Promise<void> {
  const okStatus = Array.isArray(step.okStatus) ? step.okStatus.map(String) : ['Sent', 'Delivered', 'Read']
  const status = step.status as Selector
  // Never wait past the request deadline; the backend would time out first.
  let until = Math.min(deadline, Date.now() + (typeof step.timeoutMs === 'number' ? step.timeoutMs : 30_000))
  const retrySelector = step.retry as Selector | undefined
  const pendingStatus = typeof step.pendingStatus === 'string' ? step.pendingStatus : 'Pending'
  let retried = false
  while (Date.now() < until) {
    const nodes = await dumpUi(serial)
    const activity = await topActivity(serial)
    if (activity.includes(String(step.activity || 'Conversation'))) {
      if (request.media) {
        // A media upload can stall on the cloud phone: WhatsApp shows "Pending", then a "Retry" bubble.
        // Keep waiting while it uploads and press Retry once; the staged file is still on the phone.
        const newestStatus = findAll(nodes, status).sort((a, b) => b.bounds[3] - a.bounds[3])[0]
        if (newestStatus?.desc === pendingStatus) until = deadline
        // Only the newest row is ours; an older stuck Retry bubble must never be tapped.
        const retry = retrySelector && findAll(nodes, retrySelector).sort((a, b) => b.bounds[3] - a.bounds[3])[0]
        const retryIsNewest = !!retry && !!newestStatus
          && retry.bounds[1] >= newestStatus.bounds[1] - 160 && retry.bounds[1] <= newestStatus.bounds[3] + 20
        if (retry?.clickable && retryIsNewest && !retried) {
          retried = true
          until = deadline
          await tap(serial, retry)
          await sleep(2000)
          continue
        }
      }
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

function bubbleCandidates(nodes: UiNode[], step: Step, target: BubbleTarget): UiNode[] {
  const kind = target.mediaType === 'video' ? /video/i : /photo/i
  const matching = target.text
    ? findAll(nodes, step.textBubble as Selector).filter(node => normalize(node.text) === normalize(target.text!))
    : findAll(nodes, step.mediaBubble as Selector).filter(node => kind.test(node.desc))
  if (!step.ownStatus) return matching
  // Our own messages carry a delivery status icon at the bottom of the same bubble.
  const statuses = findAll(nodes, step.ownStatus as Selector)
  return matching.filter(node => statuses.some(status => status.bounds[1] >= node.bounds[1] - 20 && status.bounds[1] <= node.bounds[3] + 60))
}

// Contract: PGW-12 — newest matching bubble, preferring the one sent at the backend's time.
async function findTargetBubble(serial: string, step: Step, reaction: BubbleTarget): Promise<UiNode | undefined> {
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
  await typeText(serial, keyword)
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
