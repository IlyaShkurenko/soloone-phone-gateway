import { timingSafeEqual } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import { config } from './config.js'
import { runOnDevice } from './device-queue.js'
import { findDevice, whatsappPackage } from './devices.js'
import { connect, release } from './drivers/index.js'
import { SendFailure, SendUncertain } from './errors.js'
import { RunError, runScript, type RunRequest } from './executor.js'
import { proposeFix } from './fixer.js'
import { prepareMedia } from './media.js'
import * as ledger from './ledger.js'
import { log } from './logger.js'
import { approveProposal, getProposal, listProposals, loadScript, rejectProposal, type Script } from './scripts.js'

interface MessageBody {
  messageId?: unknown
  from?: unknown
  to?: unknown
  text?: unknown
  typingTimeMs?: unknown
  media?: {
    type?: unknown; url?: unknown; fileName?: unknown; mimeType?: unknown
    caption?: unknown; viewOnce?: unknown; voice?: unknown
  }
}

function authorized(req: Request): boolean {
  const header = req.headers.authorization || ''
  const expected = Buffer.from(`Bearer ${config.token}`)
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const failed = (res: Response, error: string, retryable: boolean) => res.status(422).json({ outcome: 'failed', retryable, error })

// Contract: PGW-1/PGW-10 — reject unsupported content before touching any phone.
function parseBody(body: MessageBody): { from: string; request: Omit<RunRequest, 'pkg'> } | string {
  if (typeof body.messageId !== 'string' || !/^[\w-]{8,64}$/.test(body.messageId)) return 'messageId is invalid'
  if (typeof body.from !== 'string' || !/^\d{7,15}$/.test(body.from)) return 'from must be a phone number'
  if (typeof body.to !== 'string' || !/^\d{7,15}$/.test(body.to)) return 'to must be a phone number'
  const base = { messageId: body.messageId, to: body.to }
  if (body.media) {
    const media = body.media
    if (media.voice === true) return 'Voice notes are not supported by the phone gateway yet'
    if (media.type !== 'image' && media.type !== 'video') return `Media type ${String(media.type)} is not supported by the phone gateway`
    if (typeof media.url !== 'string' || !/^https?:\/\//.test(media.url)) return 'media.url is invalid'
    return { from: body.from, request: { ...base, media: {
      type: media.type, url: media.url,
      fileName: typeof media.fileName === 'string' ? media.fileName : 'media',
      mimeType: typeof media.mimeType === 'string' ? media.mimeType : undefined,
      caption: typeof media.caption === 'string' ? media.caption : undefined,
      viewOnce: media.viewOnce === true
    } } }
  }
  if (typeof body.text !== 'string' || !body.text.trim()) return 'text is required'
  return { from: body.from, request: {
    ...base, text: body.text,
    typingTimeMs: typeof body.typingTimeMs === 'number' ? Math.max(500, Math.min(30_000, body.typingTimeMs)) : undefined
  } }
}

function needsFix(trace: { recovery?: unknown[] }[], error?: unknown): boolean {
  const recovered = trace.some(entry => entry.recovery?.length)
  const missing = error instanceof RunError && error.failure instanceof SendFailure && /could not find/.test(error.message)
  return recovered || missing
}

async function sendMessage(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now()
  const parsed = parseBody(req.body as MessageBody)
  if (typeof parsed === 'string') {
    failed(res, parsed, false)
    return
  }
  const { from, request } = parsed

  // Contract: PGW-3 — one message ID never presses Send twice.
  const admission = await ledger.admit(request.messageId)
  if (admission.kind === 'in_progress') {
    res.status(409).json({ outcome: 'in_progress' })
    return
  }
  if (admission.kind === 'done') {
    if (admission.state === 'sent') res.json({ outcome: 'sent' })
    else res.status(502).json({ outcome: 'unknown', error: admission.error || 'Earlier attempt is uncertain' })
    return
  }

  let script: Script | undefined
  try {
    const device = await findDevice(from)
    if (!device) throw new SendFailure(`No phone is registered for ${from}`, false)
    script = await loadScript(request.media ? 'send_media' : 'send_text')
    const activeScript = script
    // Download and convert while the phone is being started or connected.
    const media = request.media ? { ...request.media, prepared: prepareMedia(request.messageId, request.media) } : undefined
    media?.prepared?.catch(() => undefined)
    const result = await runOnDevice(device.phone, async () => {
      const serial = await connect(device)
      try {
        return await runScript(serial, activeScript, { ...request, media, pkg: whatsappPackage(device) }, {
          startedAt,
          onSendPressed: () => ledger.markSendPressed(request.messageId)
        })
      } finally {
        release(device, serial)
      }
    })
    await ledger.finish(request.messageId, 'sent')
    res.json({ outcome: 'sent' })
    if (needsFix(result.trace)) void proposeFix({ script, reason: 'The run needed recovery actions', trace: result.trace })
  } catch (error) {
    const failure = error instanceof RunError ? error.failure : error
    if (failure instanceof SendUncertain) {
      await ledger.finish(request.messageId, 'unknown', failure.message)
      res.status(502).json({ outcome: 'unknown', error: failure.message })
    } else {
      const known = failure instanceof SendFailure ? failure : new SendFailure(failure instanceof Error ? failure.message : 'Phone gateway failed', true)
      await ledger.finish(request.messageId, 'failed', known.message)
      failed(res, known.message, known.retryable)
    }
    log.warn({ err: failure, messageId: request.messageId }, 'Phone send did not complete')
    if (script && error instanceof RunError && needsFix(error.trace, error)) {
      void proposeFix({ script, reason: error.message, trace: error.trace, evidence: error.evidence })
    }
  }
}

interface ReactionBody {
  reactionId?: unknown
  from?: unknown
  to?: unknown
  emoji?: unknown
  previousEmoji?: unknown
  target?: { text?: unknown; mediaType?: unknown; sentAt?: unknown }
}

const isEmoji = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16 && !/[\w\s]/.test(value)

// Contract: PGW-12 — set or remove one reaction on a message found by content and time.
async function sendReaction(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now()
  const body = req.body as ReactionBody
  if (typeof body.reactionId !== 'string' || !/^[\w-]{8,64}$/.test(body.reactionId)) return void failed(res, 'reactionId is invalid', false)
  if (typeof body.from !== 'string' || !/^\d{7,15}$/.test(body.from)) return void failed(res, 'from must be a phone number', false)
  if (typeof body.to !== 'string' || !/^\d{7,15}$/.test(body.to)) return void failed(res, 'to must be a phone number', false)
  if (body.emoji !== '' && !isEmoji(body.emoji)) return void failed(res, 'emoji is invalid', false)
  if (body.emoji === '' && !isEmoji(body.previousEmoji)) return void failed(res, 'Removing a reaction needs previousEmoji', false)
  const target = body.target || {}
  const text = typeof target.text === 'string' && target.text.trim() ? target.text : undefined
  const mediaType = target.mediaType === 'image' || target.mediaType === 'video' ? target.mediaType : undefined
  if (!text && !mediaType) return void failed(res, 'Only text, photo and video messages can be reacted to', false)

  const admission = await ledger.admit(body.reactionId)
  if (admission.kind === 'in_progress') return void res.status(409).json({ outcome: 'in_progress' })
  if (admission.kind === 'done') {
    if (admission.state === 'sent') res.json({ outcome: 'sent' })
    else res.status(502).json({ outcome: 'unknown', error: admission.error || 'Earlier attempt is uncertain' })
    return
  }

  try {
    const device = await findDevice(body.from)
    if (!device) throw new SendFailure(`No phone is registered for ${body.from}`, false)
    const script = await loadScript('react')
    const reactionId = body.reactionId
    await runOnDevice(device.phone, async () => {
      const serial = await connect(device)
      try {
        return await runScript(serial, script, {
          messageId: reactionId, to: body.to as string, pkg: whatsappPackage(device),
          reaction: {
            emoji: body.emoji as string,
            previousEmoji: isEmoji(body.previousEmoji) ? body.previousEmoji : undefined,
            text, mediaType, sentAt: typeof target.sentAt === 'string' ? target.sentAt : undefined
          }
        }, { startedAt, onSendPressed: () => ledger.markSendPressed(reactionId) })
      } finally {
        release(device, serial)
      }
    })
    await ledger.finish(reactionId, 'sent')
    res.json({ outcome: 'sent' })
  } catch (error) {
    const failure = error instanceof RunError ? error.failure : error
    if (failure instanceof SendUncertain) {
      await ledger.finish(body.reactionId, 'unknown', failure.message)
      res.status(502).json({ outcome: 'unknown', error: failure.message })
    } else {
      const known = failure instanceof SendFailure ? failure : new SendFailure(failure instanceof Error ? failure.message : 'Phone gateway failed', true)
      await ledger.finish(body.reactionId, 'failed', known.message)
      failed(res, known.message, known.retryable)
    }
    log.warn({ err: failure, reactionId: body.reactionId }, 'Phone reaction did not complete')
  }
}

// Contract: PGW-7 — dry-run stops before Send and clears the draft.
async function dryRun(req: Request, res: Response): Promise<void> {
  const proposal = await getProposal(req.params.id)
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' })
    return
  }
  const parsed = parseBody({ ...(req.body as MessageBody), messageId: `dry-run-${Date.now()}` })
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed })
    return
  }
  const device = await findDevice(parsed.from)
  if (!device) {
    res.status(404).json({ error: 'No phone is registered for this number' })
    return
  }
  try {
    const result = await runOnDevice(device.phone, async () => {
      const serial = await connect(device)
      try {
        return await runScript(serial, proposal.script, { ...parsed.request, pkg: whatsappPackage(device) }, {
          dryRun: true,
          startedAt: Date.now(),
          onSendPressed: async () => { throw new Error('Dry run must not press Send') }
        })
      } finally {
        release(device, serial)
      }
    })
    res.json(result)
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'Dry run failed', trace: error instanceof RunError ? error.trace : [] })
  }
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.get('/health', (_req, res) => { res.json({ ok: true }) })
app.use('/v1', (req, res, next) => authorized(req) ? next() : res.status(401).json({ error: 'Unauthorized' }))
app.post('/v1/messages', (req, res, next) => { sendMessage(req, res).catch(next) })
app.post('/v1/reactions', (req, res, next) => { sendReaction(req, res).catch(next) })
app.get('/v1/proposals', (_req, res, next) => { listProposals().then(proposals => res.json({ proposals })).catch(next) })
app.post('/v1/proposals/:id/dry-run', (req, res, next) => { dryRun(req, res).catch(next) })
app.post('/v1/proposals/:id/approve', (req, res, next) => {
  getProposal(req.params.id)
    .then(async proposal => proposal ? res.json({ script: await approveProposal(proposal) }) : res.status(404).json({ error: 'Proposal not found' }))
    .catch(next)
})
app.post('/v1/proposals/:id/reject', (req, res, next) => {
  getProposal(req.params.id)
    .then(async proposal => {
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' })
      await rejectProposal(proposal)
      return res.json({ ok: true })
    })
    .catch(next)
})
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err: error }, 'Request failed')
  if (!res.headersSent) res.status(500).json({ outcome: 'unknown', error: 'Phone gateway internal error' })
})

app.listen(config.port, config.host, () => log.info({ host: config.host, port: config.port }, 'Phone gateway started'))
