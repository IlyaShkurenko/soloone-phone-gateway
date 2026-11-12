// Contract: PGW-23–PGW-30 (RFC-012) — record what the phone shows about incoming messages and delivery
// ticks, without opening a chat, and hand them to the backend when BACKEND_EVENTS_URL is set.
import { createHash, createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pull, quote, screenshot, shell, sleep } from './adb.js'
import { config } from './config.js'
import { EventQueue } from './event-queue.js'
import { LEAVE_SCREEN_AS_IS, runOnDevice } from './device-queue.js'
import { whatsappPackage, type Device } from './devices.js'
import { connect, release } from './drivers/index.js'
import { log } from './logger.js'
import { watchNotifications } from './notification-watch.js'
import { inboxSmsAfter, lastSmsId } from './sms.js'
import { dumpUi, find, findAll, tap, type UiNode } from './ui.js'

type PhysicalDevice = Extract<Device, { driver: 'physical' }>

// With the notification stream (PGW-42) the poll is the fallback for a stream that died unnoticed.
const POLL_EVERY_MS = 5_000
const TICKS_EVERY_MS = 2 * 60 * 1000
const KEEP_DAYS = 14
const MEDIA_BEFORE_MS = 5_000
const MEDIA_WAIT_MS = 2 * 60 * 1000

export interface NotificationMessage {
  chat: string
  sender: string
  text: string
  time: number
  mimeType?: string
}

export interface TickReading {
  tick: 'read' | 'delivered' | 'sent' | 'unknown'
  ink: number
  blueShare: number
  span: number
}

type MediaKind = 'image' | 'video' | 'voice' | 'audio' | 'document'

interface PendingMedia { key: string; kind: MediaKind; time: number }

interface BackendEvent { id: string; kind: 'message' | 'tick' | 'outgoing' | 'state' | 'profile' | 'sms'; [field: string]: unknown }

interface PhoneState {
  names: Map<string, string>
  profiled: Set<string>
  profileQueue: Array<{ chat: string; phone: string }>
  seen: Set<string>
  usedFiles: Set<string>
  pending: Array<PendingMedia & { event: BackendEvent }>
  ticks: Map<string, string>
  lastOperationAt: number
  lastTicksAt: number
  // `${phone}|${text}` of customer messages recorded lately, from a notification or a chat: the same message
  // found again by the other way is not recorded twice (PGW-43).
  recent: Map<string, number>
}

const states = new Map<string, PhoneState>()
const dir = () => path.join(config.stateDir, 'incoming')
const today = () => new Date().toISOString().slice(0, 10)
const eventId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32)

// Contract: PGW-29 — the backend downloads media with a plain GET, so the URL carries its own signature.
export const mediaSignature = (name: string) => createHmac('sha256', config.token).update(name).digest('hex')

// WhatsApp's own placeholder for a media message is not a caption (PGW-28).
export function mediaCaption(text: string): string | undefined {
  const rest = text.replace(/^(📷|🎥|📹|🎤|🎵|📄|📎)\s*/u, '').trim()
  if (!rest || /^(sent an? )?(photo|video|voice message|audio|document|gif|sticker)( \(\d+:\d{2}\))?$/i.test(rest)) return undefined
  return rest
}

// The dump is filtered on the phone: only WhatsApp records, and only the lines that carry messages,
// so a poll costs about a kilobyte of mobile data instead of half a megabyte.
export function notificationFilter(pkg: string): string {
  return [
    `/^    NotificationRecord\\(/{p=index($0,"pkg=${pkg} ")>0; m=0; if(p)print "@@record"}`,
    // AICODE-NOTE: the sections after the records start with two spaces. A line in the first column is the
    // rest of a text with line breaks (android.text comes before android.messages), so it must not end the record.
    '/^  [A-Za-z]/{p=0}',
    '!p{next}',
    '/^      shortcut=/{print; next}',
    '/android\\.(template|isGroupConversation)=/{print; next}',
    '/^                android\\./{m=($0 ~ /android\\.messages=/); next}',
    'm{print}'
  ].join(' ')
}

function notificationCommand(pkg: string): string {
  return `dumpsys notification --noredact | awk ${quote(notificationFilter(pkg))}`
}

// Contract: PGW-23 — one entry per message of a one-to-one chat notification; our own lines have no sender.
export function parseNotifications(output: string): NotificationMessage[] {
  const result: NotificationMessage[] = []
  for (const record of output.split('@@record').slice(1)) {
    if (!/Notification\$MessagingStyle/.test(record) || /isGroupConversation=Boolean \(true\)/.test(record)) continue
    const chat = record.match(/^\s*shortcut=(\S+) found valid/m)?.[1]
    if (!chat) continue
    for (const raw of record.split(/^\s*\[\d+\] Bundle\[\{/m).slice(1)) {
      const body = raw.replace(/\}\]\s*$/, '')
      const sender = body.match(/sender=(.*?), (?:uri=|text=)/s)?.[1]
      const times = [...body.matchAll(/, time=(\d+)/g)]
      const textStart = body.search(/(?:^|, )text=/)
      if (!sender || sender === 'null' || !times.length || textStart < 0) continue
      const last = times[times.length - 1]
      const text = body.slice(body.indexOf('text=', textStart) + 5, last.index)
      const mimeType = body.slice(last.index! + last[0].length).match(/^, type=([\w.+/-]+)/)?.[1]
      result.push({ chat, sender, text, time: Number(last[1]), ...(mimeType ? { mimeType } : {}) })
    }
  }
  return result
}

export function mediaKind(message: NotificationMessage): MediaKind | undefined {
  if (message.mimeType?.startsWith('image/') || message.text.startsWith('📷')) return 'image'
  if (message.mimeType?.startsWith('video/') || /^(🎥|📹)/u.test(message.text)) return 'video'
  if (message.text.startsWith('🎤')) return 'voice'
  if (message.mimeType?.startsWith('audio/') || message.text.startsWith('🎵')) return 'audio'
  if (/^(📄|📎)/u.test(message.text)) return 'document'
  return undefined
}

const FOLDERS: Record<MediaKind, string> = {
  image: 'Images', video: 'Video', voice: 'Voice Notes', audio: 'Audio', document: 'Documents'
}

// Contract: PGW-26 — the chat list shows ticks only as an icon: blue means read, two ticks are wider than one.
export function classifyTick(rgb: Buffer, width: number): TickReading {
  const pixels = Math.floor(rgb.length / 3)
  const [br, bg, bb] = [rgb[0], rgb[1], rgb[2]]
  let ink = 0
  let blue = 0
  let minCol = width
  let maxCol = -1
  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
    if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) < 90) continue
    ink++
    if (b > r + 50 && b > 120) blue++
    minCol = Math.min(minCol, i % width)
    maxCol = Math.max(maxCol, i % width)
  }
  const blueShare = ink ? blue / ink : 0
  const span = maxCol >= minCol ? (maxCol - minCol + 1) / width : 0
  const tick = ink < 15 ? 'unknown' : blueShare > 0.5 ? 'read' : span > 0.6 ? 'delivered' : 'sent'
  return { tick, ink, blueShare: Math.round(blueShare * 100) / 100, span: Math.round(span * 100) / 100 }
}

async function write(phone: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dir(), { recursive: true })
  await appendFile(path.join(dir(), `${today()}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), phone, ...record })}\n`)
}

// Rebuilt from the last two days of records so a restart does not record the same message twice.
async function loadState(phone: string): Promise<PhoneState> {
  const existing = states.get(phone)
  if (existing) return existing
  const state: PhoneState = { names: new Map(), profiled: new Set(), profileQueue: [], seen: new Set(), usedFiles: new Set(), pending: [], ticks: new Map(), lastOperationAt: 0, lastTicksAt: 0, recent: new Map() }
  const files = (await readdir(dir()).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl')).sort().slice(-2)
  const messages: Array<{ at: number; source?: string; chat?: string; sender?: string; text: string }> = []
  for (const name of files) {
    for (const line of (await readFile(path.join(dir(), name), 'utf8')).split('\n')) {
      if (!line) continue
      const record = JSON.parse(line) as { at?: string; phone?: string; key?: string; file?: string; kind?: string; chat?: string; tick?: string; preview?: string; source?: string; sender?: string; text?: string }
      if (record.phone !== phone) continue
      if (record.key) state.seen.add(record.key)
      if (record.file) state.usedFiles.add(record.file)
      if (record.kind === 'tick' && record.chat && record.tick) state.ticks.set(`${record.chat}|${record.preview ?? ''}`, record.tick)
      const at = Date.parse(record.at ?? '')
      if (record.kind === 'message' && typeof record.text === 'string' && Date.now() - at <= KNOWN_MS) messages.push({ ...record, at, text: record.text })
    }
  }
  const names = await readFile(path.join(dir(), `names-${phone}.json`), 'utf8').then(JSON.parse).catch(() => ({})) as Record<string, string>
  for (const [name, to] of Object.entries(names)) state.names.set(name, to)
  // PGW-47 must know what was recorded just before a restart.
  for (const message of messages) {
    const to = message.source === 'chat' ? message.chat : phoneFromName(message.sender) || (message.sender && state.names.get(message.sender)) || message.sender
    if (to) remember(state, to, message.text, message.at)
  }
  const profiled = await readFile(path.join(dir(), `profiled-${phone}.json`), 'utf8').then(JSON.parse).catch(() => []) as string[]
  for (const chat of profiled) state.profiled.add(chat)
  states.set(phone, state)
  return state
}

// Contract: PGW-28, PGW-40 — kept in a SQLite table until the backend accepts it; the event ID makes a resend harmless.
let queue: EventQueue | undefined
function events(): EventQueue {
  if (!queue) {
    queue = new EventQueue(path.join(dir(), 'events.sqlite'))
    const imported = queue.importLegacy(path.join(dir(), 'outbox.json'))
    if (imported) log.info({ imported }, 'Earlier phone event outbox imported')
  }
  return queue
}

async function enqueue(phone: string, event: BackendEvent): Promise<void> {
  if (!config.backendEventsUrl) return
  events().add(phone, event)
  // Sent at once while the backend answers; a later failure waits its pause, and the 5-second round picks it up.
  void flushOutbox().catch(error => log.warn({ err: error }, 'Phone events not delivered to the backend yet'))
}

// 400 and 422 mean the backend rejects these events; anything else (a network error, a 5xx, a wrong token,
// a deploy in progress) is the backend being unavailable, which never sets an event aside.
const isRefusal = (status: number) => status === 400 || status === 422

let flushing = false
async function flushOutbox(): Promise<void> {
  if (!config.backendEventsUrl || flushing) return
  flushing = true
  try {
    for (let batch = events().next(); batch; batch = events().next()) {
      const ids = batch.events.map(event => event.id)
      let status: number
      try {
        const response = await fetch(config.backendEventsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ phone: batch.phone, events: batch.events }),
          signal: AbortSignal.timeout(60_000)
        })
        await response.body?.cancel()
        status = response.status
      } catch (error) {
        events().failed(ids, error instanceof Error ? error.message : String(error), false)
        throw error
      }
      if (status >= 200 && status < 300) {
        events().sent(ids)
        continue
      }
      for (const id of events().failed(ids, `HTTP ${status}`, isRefusal(status))) {
        log.warn({ phone: batch.phone, eventId: id, status }, 'Phone event set aside after repeated backend refusals')
      }
      if (!isRefusal(status)) throw new Error(`Backend returned ${status} for phone events`)
    }
  } finally {
    flushing = false
  }
}

// A contact not saved on the phone is shown by its number, which ties the LID chat to a phone (WA-PGW-IN-10).
export function phoneFromName(name: string | undefined): string | undefined {
  const digits = name?.replace(/[\s()+-]/g, '')
  return digits && /^\d{7,15}$/.test(digits) ? digits : undefined
}

function messageEvent(key: string, chat: string, message: { sender?: string; text: string; time: number }): BackendEvent {
  const phone = phoneFromName(message.sender)
  return { id: eventId(key), kind: 'message', chat, senderName: message.sender, text: message.text, time: message.time, ...(phone ? { phone } : {}) }
}

// Contract: PGW-33 — the backend treats a phone-sending number as connected while its phone answers.
export async function reportPhoneState(phone: string, online: boolean): Promise<void> {
  await enqueue(phone, { id: eventId(`s|${phone}|${online}|${Date.now()}`), kind: 'state', online, time: Date.now() })
}

async function pollNotifications(device: PhysicalDevice, serial: string, state: PhoneState): Promise<void> {
  const messages = parseNotifications(await shell(serial, notificationCommand(whatsappPackage(device)), 30_000))
  for (const message of messages) {
    const key = `n|${message.chat}|${message.time}|${message.text}`
    if (state.seen.has(key)) continue
    state.seen.add(key)
    // A reaction notification reads like a message; reactions from the phone are not reported (RFC-012).
    if (/^Reacted .+ to "/s.test(message.text)) {
      await write(device.phone, { kind: 'reaction', key, ...message })
      continue
    }
    const kind = mediaKind(message)
    const from = phoneFromName(message.sender) || (message.sender ? state.names.get(message.sender) : undefined)
    // A sender with no known number is remembered by name; the chat header shows the same name (PGW-47).
    if (from || message.sender) remember(state, from || message.sender, message.text)
    await write(device.phone, { kind: 'message', source: 'notification', key, ...message, ...(kind ? { media: kind } : {}) })
    const event = messageEvent(key, message.chat, message)
    // Contract: PGW-35 — a sender the phone shows only by number gets its WhatsApp profile name read once.
    const senderPhone = phoneFromName(message.sender)
    if (senderPhone && !state.profiled.has(message.chat) && !state.profileQueue.some(item => item.chat === message.chat)) {
      state.profileQueue.push({ chat: message.chat, phone: senderPhone })
    }
    // A media message waits for its file so the backend gets both together.
    if (kind) state.pending.push({ key, kind, time: message.time, event })
    else await enqueue(device.phone, event)
  }
}

// Contract: PGW-24 — the oldest unused file of the right type saved around the message time.
async function collectMedia(device: PhysicalDevice, serial: string, state: PhoneState): Promise<void> {
  if (!state.pending.length) return
  const pkg = whatsappPackage(device)
  const prefix = pkg === 'com.whatsapp.w4b' ? 'WhatsApp Business' : 'WhatsApp'
  const base = `/sdcard/Android/media/${pkg}/${prefix}/Media`
  const listing = await shell(serial, `find ${quote(base)} -type f -mmin -30 ! -path '*/Sent/*' ! -path '*/Private/*' ! -name .nomedia -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`, 30_000)
  const files = listing.split('\n').map(line => line.trim().split('|')).filter(parts => parts.length === 3)
    .map(([mtime, size, file]) => ({ at: Number(mtime) * 1000, size: Number(size), file }))
    .sort((a, b) => a.at - b.at)
  for (const item of [...state.pending].sort((a, b) => a.time - b.time)) {
    const folder = `/${prefix} ${FOLDERS[item.kind]}/`
    const match = files.find(file => file.file.includes(folder) && !state.usedFiles.has(file.file)
      && file.at >= item.time - MEDIA_BEFORE_MS && file.at <= item.time + MEDIA_WAIT_MS)
    if (match) {
      state.usedFiles.add(match.file)
      const target = path.join(dir(), 'media', `${today()}_${path.basename(match.file)}`)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, await pull(serial, match.file))
      await write(device.phone, { kind: 'media', key: item.key, file: match.file, saved: path.basename(target), size: match.size })
      const name = path.basename(target)
      await enqueue(device.phone, { ...item.event, media: {
        kind: item.kind, fileName: path.basename(match.file).replace(/\.opus$/i, '.oga'), mimeType: mimeOf(match.file), caption: mediaCaption(String(item.event.text)),
        url: `http://127.0.0.1:${config.port}/v1/incoming-media/${encodeURIComponent(name)}?sig=${mediaSignature(name)}`
      } })
    } else if (Date.now() > item.time + MEDIA_WAIT_MS) {
      await write(device.phone, { kind: 'media_missing', key: item.key, media: item.kind })
      // Without the file the backend still learns that something arrived, as text.
      await enqueue(device.phone, item.event)
    } else {
      continue
    }
    state.pending = state.pending.filter(pending => pending !== item)
  }
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', '3gp': 'video/3gpp',
  // Whapi stores voice notes as .oga with the codec named; iOS does not play the same file as plain audio/ogg .opus.
  opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg; codecs=opus', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', pdf: 'application/pdf'
}
const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream'

const inside = (node: UiNode, box: UiNode) => node.bounds[1] >= box.bounds[1] && node.bounds[3] <= box.bounds[3]

function cropRaw(png: Buffer, [x1, y1, x2, y2]: UiNode['bounds']): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(config.ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `crop=${x2 - x1}:${y2 - y1}:${x1}:${y1}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
    (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin?.end(png)
  })
}

// Contract: PGW-26 — the chat list is opened with its task cleared, so WhatsApp never resumes the last open chat.
async function readTicks(device: PhysicalDevice, serial: string, state: PhoneState): Promise<void> {
  const pkg = whatsappPackage(device)
  let nodes: UiNode[]
  let png: Buffer
  try {
    await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -W -f 0x10008000 -n ${pkg}/com.whatsapp.Main >/dev/null`, 30_000)
    await sleep(1500)
    nodes = await dumpUi(serial)
    // The Google backup setup screen can stand in front of the chat list too, with "Not now".
    const notNow = find(nodes, { text: 'NOT NOW' }) ?? find(nodes, { resourceId: 'com.whatsapp:id/gdrive_new_user_setup_not_now_btn' })
    if (notNow) {
      await tap(serial, notNow)
      await sleep(1500)
      nodes = await dumpUi(serial)
    }
    if (!find(nodes, { resourceId: 'com.whatsapp:id/conversations_row_contact_name' })) return
    png = await screenshot(serial)
  } finally {
    await shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined)
  }
  const missed: Array<{ to: string; header: string; preview: string }> = []
  const now = await phoneMinute(serial).catch(() => undefined)
  for (const row of findAll(nodes, { resourceId: 'com.whatsapp:id/contact_row_container' })) {
    const name = nodes.find(node => node.resourceId === 'com.whatsapp:id/conversations_row_contact_name' && inside(node, row))
    const icon = nodes.find(node => node.resourceId === 'com.whatsapp:id/status_indicator' && inside(node, row))
    // Contract: PGW-47 — a row whose last message is his (no tick icon), from the last minutes and not recorded.
    if (name?.text && !icon && now !== undefined) {
      const to = phoneFromName(name.text) || state.names.get(name.text)
      const preview = nodes.find(node => node.resourceId === 'com.whatsapp:id/single_msg_tv' && inside(node, row))?.text
      const date = nodes.find(node => node.resourceId === 'com.whatsapp:id/conversations_row_date' && inside(node, row))?.text
      if (to && preview && isFresh(date, now) && !recordedStart(state, [to, name.text], preview, KNOWN_MS)) missed.push({ to, header: name.text, preview })
    }
    if (!name?.text || !icon) continue
    const reading = classifyTick(await cropRaw(png, icon.bounds), icon.bounds[2] - icon.bounds[0])
    const preview = nodes.find(node => node.resourceId === 'com.whatsapp:id/single_msg_tv' && inside(node, row))?.text || ''
    const date = nodes.find(node => node.resourceId === 'com.whatsapp:id/conversations_row_date' && inside(node, row))?.text || ''
    // A new message of ours in the same chat can reach the same tick as the previous one, so the preview is part of the key.
    const tickKey = `${name.text}|${preview}`
    if (state.ticks.get(tickKey) === reading.tick) continue
    state.ticks.set(tickKey, reading.tick)
    await write(device.phone, { kind: 'tick', chat: name.text, preview, date, ...reading })
    // Contract: PGW-30 — a name is a phone number or the chat header seen when the gateway last opened that chat.
    const to = phoneFromName(name.text) || state.names.get(name.text)
    if (to && (reading.tick === 'delivered' || reading.tick === 'read')) {
      await enqueue(device.phone, { id: eventId(`t|${to}|${reading.tick}|${preview}|${Date.now()}`), kind: 'tick', to, tick: reading.tick, preview })
    }
  }
  if (!missed.length) return
  // Opening the chat list can take a notification away; one still there is recorded first, not twice.
  await pollNotifications(device, serial, state)
  for (const item of missed.slice(0, 3)) {
    if (recordedStart(state, [item.to, item.header], item.preview, KNOWN_MS)) continue
    await readMissedChat(device, serial, item.to, item.header)
    log.info({ phone: device.phone, to: item.to }, 'A message missed by the notifications was read from the chat')
  }
}

// Contract: PGW-47 — opens the chat; its capture records the fresh customer bubbles that were not recorded.
async function readMissedChat(device: PhysicalDevice, serial: string, to: string, header: string): Promise<void> {
  const pkg = whatsappPackage(device)
  try {
    await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${to}`)} -p ${quote(pkg)} >/dev/null`)
    let nodes: UiNode[] = []
    for (const until = Date.now() + 10_000; Date.now() < until; await sleep(700)) {
      nodes = await dumpUi(serial)
      if (find(nodes, { resourceId: 'com.whatsapp:id/conversation_contact_name' })?.text === header) break
    }
    if (find(nodes, { resourceId: 'com.whatsapp:id/conversation_contact_name' })?.text !== header) return
    const capture = chatCapture(device, to, '')
    capture.opened(nodes)
    await capture.beforeLeave(serial)
  } finally {
    await shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined)
  }
}

async function readProfile(device: PhysicalDevice, serial: string, state: PhoneState, item: { chat: string; phone: string }): Promise<void> {
  const pkg = whatsappPackage(device)
  let title: string | undefined
  let subtitle: string | undefined
  let capture: ReturnType<typeof chatCapture> | undefined
  try {
    await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${item.phone}`)} -p ${quote(pkg)} >/dev/null`)
    let header: UiNode | undefined
    let nodes: UiNode[] = []
    for (const until = Date.now() + 12_000; !header && Date.now() < until; await sleep(800)) {
      nodes = await dumpUi(serial)
      header = find(nodes, { resourceId: 'com.whatsapp:id/conversation_contact' })
    }
    if (!header) return
    // Contract: PGW-35 — while the chat is open its new messages raise no notification; they are read from the chat before leaving.
    capture = chatCapture(device, item.phone, '')
    capture.opened(nodes)
    await tap(serial, header)
    for (const until = Date.now() + 10_000; !title && Date.now() < until; await sleep(800)) {
      const info = await dumpUi(serial)
      // A WhatsApp Business account shows its business name and number instead of the contact fields.
      title = find(info, { resourceId: 'com.whatsapp:id/contact_title' })?.text ?? find(info, { resourceId: 'com.whatsapp:id/business_title' })?.text
      subtitle = find(info, { resourceId: 'com.whatsapp:id/contact_subtitle' })?.text
    }
  } finally {
    if (capture) {
      await shell(serial, 'input keyevent KEYCODE_BACK').catch(() => undefined)
      await sleep(800)
      await capture.beforeLeave(serial).catch(error => log.warn({ err: error, phone: device.phone }, 'Chat capture after a profile read failed'))
      await shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined)
    } else {
      await shell(serial, 'input keyevent KEYCODE_BACK; input keyevent KEYCODE_HOME').catch(() => undefined)
    }
    state.lastOperationAt = Date.now()
  }
  // The profile screen shows the saved name or the number as its title and "~ name" for the name the person set;
  // a business shows its business name as the title.
  const name = subtitle?.startsWith('~') ? subtitle : title && !phoneFromName(title) ? title : undefined
  state.profiled.add(item.chat)
  await writeFile(path.join(dir(), `profiled-${device.phone}.json`), JSON.stringify([...state.profiled]))
  await write(device.phone, { kind: 'profile', chat: item.chat, phone: item.phone, title, subtitle })
  if (name) await enqueue(device.phone, { id: eventId(`p|${item.chat}`), kind: 'profile', chat: item.chat, phone: item.phone, name })
}

function capturing(device: Device): PhysicalDevice | undefined {
  return device.driver === 'physical' && device.captureIncoming !== false ? device : undefined
}

// Contract: PGW-23 — called under the device lock right before an operation opens a chat,
// because opening the chat clears its notification.
// Contract: PGW-31 — a text the phone sent is reported so the backend shows it in the chat; the backend
// skips the ones it queued itself, which carry its own message ID.
export async function reportOutgoing(device: Device, messageId: string, to: string, text: string): Promise<void> {
  const physical = capturing(device)
  if (!physical) return
  await enqueue(physical.phone, { id: eventId(`o|${messageId}`), kind: 'outgoing', messageId, to, text, time: Date.now() })
}

export async function captureBeforeOperation(device: Device, serial: string): Promise<void> {
  const physical = capturing(device)
  if (!physical) return
  const state = await loadState(physical.phone)
  state.lastOperationAt = Date.now()
  await pollNotifications(physical, serial, state).catch(error => log.warn({ err: error, phone: physical.phone }, 'Incoming capture before operation failed'))
}

const sameText = (a: string, b: string) => {
  const plain = (value: string) => value.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()
  return plain(a) === plain(b)
}

// Contract: PGW-25 — after a text send, customer bubbles below the newest bubble seen when the chat opened arrived
// while it was open, so they had no notification: also those that came in while our text was being typed.
// Other operations may leave the chat scrolled up, where older bubbles sit below ours, so they skip it.
// `startAnchor` is the newest bubble when the previous send left the chat open (PGW-37).
export function chatCapture(device: Device, to: string, sentText: string, startAnchor?: Bubble): {
  opened: (nodes: UiNode[]) => void
  beforeLeave: (serial: string, sent?: boolean) => Promise<void>
  last: () => Bubble | undefined
} {
  let anchor = startAnchor
  let shownOnOpen: Bubble[] | undefined
  return {
    opened: nodes => {
      shownOnOpen = chatBubbles(nodes)
      anchor = shownOnOpen.at(-1)
    },
    last: () => anchor,
    beforeLeave: async (serial: string, sent = true) => {
      const physical = capturing(device)
      if (!physical) return
      const state = await loadState(physical.phone)
      state.lastOperationAt = Date.now()
      const nodes = await dumpUi(serial)
      const header = find(nodes, { resourceId: 'com.whatsapp:id/conversation_contact_name' })?.text
      if (header && state.names.get(header) !== to) {
        state.names.set(header, to)
        await mkdir(dir(), { recursive: true })
        await writeFile(path.join(dir(), `names-${physical.phone}.json`), JSON.stringify(Object.fromEntries(state.names)))
      }
      const bubbles = chatBubbles(nodes)
      // A send that stopped before Send left no bubble of ours; what came after the anchor still arrived meanwhile.
      const found = newChatBubbles(anchor, bubbles, sent ? sentText : '')
      // Contract: PGW-47 — fresh customer bubbles already there when the chat opened that no way recorded.
      const opened = shownOnOpen
      shownOnOpen = undefined
      if (opened && hasFreshCandidate(opened)) {
        const now = await phoneMinute(serial).catch(() => undefined)
        const names = header ? [to, header] : [to]
        if (now !== undefined) found.unshift(...missedBubbles(opened, now, text => recordedWithin(state, names, text, KNOWN_MS)))
      }
      // What is on screen now is recorded; a later look starts below it.
      if (bubbles.length) anchor = bubbles.at(-1)
      for (const { bubble, key: suffix } of found) {
        const key = `c|${to}|${suffix}`
        if (state.seen.has(key)) continue
        state.seen.add(key)
        if (recorded(state, to, bubble.text)) continue
        remember(state, to, bubble.text)
        await write(physical.phone, { kind: 'message', source: 'chat', key, chat: to, text: bubble.text, timeLabel: bubble.label })
        // The bubble arrived while the chat was open, so the capture time stands in for the minute label.
        await enqueue(physical.phone, messageEvent(key, `${to}@s.whatsapp.net`, { text: bubble.text, time: Date.now() }))
      }
    }
  }
}

const RECENT_MS = 3 * 60 * 1000
// PGW-47 looks back FRESH_MINUTES at bubble labels and so needs a longer memory of what was recorded.
const FRESH_MINUTES = 10
const KNOWN_MS = 15 * 60 * 1000
const recentKey = (to: string, text: string) => `${to}|${text.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()}`
function remember(state: PhoneState, to: string, text: string, at = Date.now()): void {
  const key = recentKey(to, text)
  state.recent.set(key, Math.max(at, state.recent.get(key) ?? 0))
  const now = Date.now()
  for (const [item, when] of state.recent) if (now - when > KNOWN_MS) state.recent.delete(item)
}
// The chat list shows the start of a long message, cut with an ellipsis.
function recordedStart(state: PhoneState, names: string[], preview: string, within = RECENT_MS): boolean {
  const now = Date.now()
  for (const name of names) {
    const start = recentKey(name, preview).replace(/(…|\.\.\.)$/, '').trim()
    for (const [key, at] of state.recent) if (now - at <= within && key.startsWith(start)) return true
  }
  return false
}
function recordedWithin(state: PhoneState, names: string[], text: string, within: number): boolean {
  return names.some(name => {
    const at = state.recent.get(recentKey(name, text))
    return at !== undefined && Date.now() - at <= within
  })
}
const recorded = (state: PhoneState, to: string, text: string) => recordedWithin(state, [to], text, RECENT_MS)

// Minutes since midnight on the phone's clock, the clock its chat labels use.
async function phoneMinute(serial: string): Promise<number> {
  const minute = labelMinute((await shell(serial, 'date +%H:%M')).trim())
  if (minute === undefined) throw new Error('Phone time is not readable')
  return minute
}

export function labelMinute(label: string | undefined): number | undefined {
  const match = label?.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s?m\.?)?$/i)
  if (!match) return undefined
  const hours = Number(match[1]) % (match[3] ? 12 : 24) + (match[3]?.toLowerCase() === 'p' ? 12 : 0)
  return hours * 60 + Number(match[2])
}

// A label shows only the time for today; "Yesterday" or a date is never fresh.
function isFresh(label: string | undefined, now: number): boolean {
  const minute = labelMinute(label)
  return minute !== undefined && (now - minute + 1440) % 1440 <= FRESH_MINUTES
}

const hasFreshCandidate = (bubbles: Bubble[]) => bubbles.slice(lastIndex(bubbles, bubble => bubble.own) + 1).some(bubble => !bubble.own)

// Contract: PGW-47 — customer bubbles below our newest one, labelled within the last minutes and not recorded,
// are messages no notification brought: one that came while WhatsApp was open on another screen.
export function missedBubbles(bubbles: Bubble[], now: number, known: (text: string) => boolean): Array<{ bubble: Bubble; key: string }> {
  const counts = new Map<string, number>()
  const found: Array<{ bubble: Bubble; key: string }> = []
  for (const bubble of bubbles.slice(lastIndex(bubbles, item => item.own) + 1)) {
    const base = `${bubble.label}|${bubble.text}`
    const count = (counts.get(base) || 0) + 1
    counts.set(base, count)
    if (bubble.own || !isFresh(bubble.label, now) || known(bubble.text)) continue
    found.push({ bubble, key: count > 1 ? `${base}|${count}` : base })
  }
  return found
}

// Contract: PGW-43 — a message that reaches the chat in the moment the gateway leaves it gets no notification.
// A few seconds after leaving, the chat list is read once: an unread badge on that chat means such a message,
// and the chat is opened to read the customer bubbles below the one last seen there.
const RECHECK_AFTER_MS = 3000
// One pending recheck per chat: the parts of one reply sent in a row are rechecked once, after the last.
const rechecks = new Map<string, NodeJS.Timeout>()
export function recheckAfterLeave(device: Device, to: string, header: string, anchor: Bubble | undefined): void {
  const physical = capturing(device)
  if (!physical || !header) return
  const chatKey = `${physical.phone}|${to}`
  clearTimeout(rechecks.get(chatKey))
  rechecks.set(chatKey, setTimeout(() => {
    rechecks.delete(chatKey)
    void runOnDevice(physical.phone, async () => {
      const serial = await connect(physical)
      const state = await loadState(physical.phone)
      await pollNotifications(physical, serial, state).catch(() => undefined)
      const pkg = whatsappPackage(physical)
      try {
        await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -W -f 0x10008000 -n ${pkg}/com.whatsapp.Main >/dev/null`, 30_000)
        await sleep(1200)
        const nodes = await dumpUi(serial)
        const row = findAll(nodes, { resourceId: 'com.whatsapp:id/contact_row_container' })
          .find(item => nodes.some(node => node.resourceId === 'com.whatsapp:id/conversations_row_contact_name' && node.text === header && inside(node, item)))
        if (!row) return
        // The row shows the chat's last message; ours carries a tick icon there, his does not. A message of his that
        // came as the chat was being left is shown read (it reached the open chat), so the unread badge cannot tell.
        if (nodes.some(node => node.resourceId === 'com.whatsapp:id/status_indicator' && inside(node, row))) return
        const preview = nodes.find(node => node.resourceId === 'com.whatsapp:id/single_msg_tv' && inside(node, row))?.text
        if (!preview || recordedStart(state, [to], preview)) return
        await shell(serial, `am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${to}`)} -p ${quote(pkg)} >/dev/null`)
        for (const until = Date.now() + 10_000; Date.now() < until; await sleep(700)) {
          if (find(await dumpUi(serial), { resourceId: 'com.whatsapp:id/conversation_contact_name' })?.text === header) break
        }
        await chatCapture(physical, to, '', anchor).beforeLeave(serial)
        log.info({ phone: physical.phone, to }, 'A message that arrived as the chat was left was read from the chat')
      } finally {
        state.lastOperationAt = Date.now()
        await shell(serial, 'input keyevent KEYCODE_HOME').catch(() => undefined)
        release(physical, serial)
      }
    }).catch(error => log.warn({ err: error, phone: physical.phone }, 'Recheck after leaving a chat failed'))
  }, RECHECK_AFTER_MS))
  rechecks.get(chatKey)?.unref?.()
}

export interface Bubble { text: string; label: string; own: boolean }

// Customer bubbles that came after `anchor`, with their key. When the anchor is gone from the screen, or the chat
// showed nothing when it opened, only the bubbles below our sent one are taken, as they surely are new.
export function newChatBubbles(anchor: Bubble | undefined, bubbles: Bubble[], sentText: string): Array<{ bubble: Bubble; key: string }> {
  // Without a text of ours (a profile read, PGW-35) there is no sent bubble: only what came after the anchor counts.
  const ownIndex = sentText ? lastIndex(bubbles, bubble => bubble.own) : bubbles.length
  if (sentText && (ownIndex < 0 || !sameText(bubbles[ownIndex].text, sentText))) return []
  // The anchor is the nearest bubble above ours that looks like it.
  const anchorIndex = anchor
    ? lastIndex(bubbles.slice(0, ownIndex), bubble => bubble.own === anchor.own && bubble.label === anchor.label && sameText(bubble.text, anchor.text))
    : -1
  // With no anchor on screen nothing tells old bubbles from new ones; none is taken rather than recorded twice.
  if (!sentText && anchorIndex < 0) return []
  const counts = new Map<string, number>()
  const found: Array<{ bubble: Bubble; key: string }> = []
  for (const bubble of bubbles.slice((anchorIndex >= 0 ? anchorIndex : ownIndex) + 1)) {
    if (bubble.own) continue
    const base = `${bubble.label}|${bubble.text}`
    // Two equal bubbles in the same minute are two messages.
    const count = (counts.get(base) || 0) + 1
    counts.set(base, count)
    found.push({ bubble, key: count > 1 ? `${base}|${count}` : base })
  }
  return found
}

function lastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index
  return -1
}

// Text bubbles from top to bottom; ours carry a delivery status icon in their row.
export function chatBubbles(nodes: UiNode[]): Bubble[] {
  const statuses = findAll(nodes, { resourceId: 'com.whatsapp:id/status' })
  const dates = findAll(nodes, { resourceId: 'com.whatsapp:id/date' })
  const rowOf = (bubble: UiNode) => (node: UiNode) => node.bounds[1] >= bubble.bounds[1] - 20 && node.bounds[1] <= bubble.bounds[3] + 60
  return findAll(nodes, { resourceId: 'com.whatsapp:id/message_text' })
    .sort((a, b) => a.bounds[1] - b.bounds[1])
    .map(node => ({ text: node.text, label: dates.find(rowOf(node))?.text || '', own: statuses.some(rowOf(node)) }))
}

async function prune(): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  events().prune(KEEP_DAYS * 24 * 60 * 60 * 1000)
  for (const folder of [dir(), path.join(dir(), 'media')]) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const file = path.join(folder, name)
      const info = await stat(file)
      if (info.isFile() && info.mtimeMs < cutoff) await rm(file, { force: true })
    }
  }
}

// Contract: PGW-46 — new SMS in the phone's inbox, after the newest one seen. The first look starts from the
// newest SMS already on the phone, so older ones are not reported.
const smsSeen = new Map<string, number>()
async function pollSms(device: PhysicalDevice, serial: string): Promise<void> {
  const file = path.join(dir(), `sms-${device.phone}.json`)
  let last = smsSeen.get(device.phone)
  if (last === undefined) {
    const saved = await readFile(file, 'utf8').then(JSON.parse).catch(() => null) as { lastId?: unknown } | null
    last = typeof saved?.lastId === 'number' ? saved.lastId : await lastSmsId(serial)
    smsSeen.set(device.phone, last)
    if (typeof saved?.lastId !== 'number') {
      await mkdir(dir(), { recursive: true })
      await writeFile(file, JSON.stringify({ lastId: last }))
    }
  }
  const fresh = await inboxSmsAfter(serial, last)
  if (!fresh.length) return
  for (const sms of fresh) {
    const key = `sms|${device.phone}|${sms.id}|${sms.date}`
    await write(device.phone, { kind: 'sms', key, from: sms.address, text: sms.body, time: sms.date })
    await enqueue(device.phone, { id: eventId(key), kind: 'sms', from: sms.address, text: sms.body, time: sms.date })
  }
  smsSeen.set(device.phone, fresh[fresh.length - 1].id)
  await writeFile(file, JSON.stringify({ lastId: fresh[fresh.length - 1].id }))
}

async function tick(device: PhysicalDevice): Promise<void> {
  const state = await loadState(device.phone)
  await runOnDevice(device.phone, async screenHeld => {
    const serial = await connect(device)
    await pollNotifications(device, serial, state)
    await pollSms(device, serial).catch(error => log.warn({ err: error, phone: device.phone }, 'SMS inbox read failed'))
    await collectMedia(device, serial, state)
    // PGW-37: a chat held open for the next part of a reply is not left for a profile or the chat list.
    if (screenHeld) return
    const profile = state.profileQueue.shift()
    if (profile) await readProfile(device, serial, state, profile)
    const idle = Date.now() - state.lastOperationAt >= TICKS_EVERY_MS
    if (idle && Date.now() - state.lastTicksAt >= TICKS_EVERY_MS) {
      state.lastTicksAt = Date.now()
      await readTicks(device, serial, state)
    }
  }, LEAVE_SCREEN_AS_IS)
}

export function startIncomingCapture(): void {
  const busy = new Set<string>()
  // A notification that arrives while a round is running gets a round of its own right after.
  const again = new Set<string>()
  const offline = new Set<string>()
  const watched = new Set<string>()
  const capture = (device: PhysicalDevice) => {
    // A slow round must not stack up behind itself.
    if (busy.has(device.phone)) {
      again.add(device.phone)
      return
    }
    busy.add(device.phone)
    tick(device)
      .then(() => offline.delete(device.phone))
      .catch(error => {
        // An offline phone is reported by the watchdog (PGW-18); log the first miss only.
        if (!offline.has(device.phone)) log.warn({ err: error, phone: device.phone }, 'Incoming capture failed')
        offline.add(device.phone)
      })
      .finally(() => {
        busy.delete(device.phone)
        if (again.delete(device.phone)) capture(device)
      })
  }
  const run = async () => {
    const devices = (JSON.parse(await readFile(config.devicesFile, 'utf8')) as Device[])
      .filter((device): device is PhysicalDevice => device.driver === 'physical' && device.captureIncoming !== false)
    for (const device of devices) {
      // Contract: PGW-42 — a WhatsApp notification on the phone starts a capture at once.
      if (!watched.has(device.phone)) {
        watched.add(device.phone)
        watchNotifications(device.adbAddress, () => capture(device))
      }
      capture(device)
    }
  }
  void run().catch(error => log.warn({ err: error }, 'Incoming capture round failed'))
  setInterval(() => {
    run().catch(error => log.warn({ err: error }, 'Incoming capture round failed'))
    flushOutbox().catch(error => log.warn({ err: error }, 'Phone events not delivered to the backend yet'))
  }, POLL_EVERY_MS)
  setInterval(() => { prune().catch(() => undefined) }, 6 * 60 * 60 * 1000)
}
