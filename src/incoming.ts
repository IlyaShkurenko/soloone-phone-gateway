// Contract: PGW-23–PGW-30 (RFC-012) — record what the phone shows about incoming messages and delivery
// ticks, without opening a chat, and hand them to the backend when BACKEND_EVENTS_URL is set.
import { createHash, createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pull, quote, screenshot, shell, sleep } from './adb.js'
import { config } from './config.js'
import { runOnDevice } from './device-queue.js'
import { whatsappPackage, type Device } from './devices.js'
import { connect } from './drivers/index.js'
import { log } from './logger.js'
import { dumpUi, find, findAll, tap, type UiNode } from './ui.js'

type PhysicalDevice = Extract<Device, { driver: 'physical' }>

const POLL_EVERY_MS = 15_000
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

interface BackendEvent { id: string; kind: 'message' | 'tick' | 'outgoing' | 'state' | 'profile'; [field: string]: unknown }

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
function notificationCommand(pkg: string): string {
  const program = [
    `/^    NotificationRecord\\(/{p=index($0,"pkg=${pkg} ")>0; m=0; if(p)print "@@record"}`,
    '/^(  )?[A-Za-z]/{p=0}',
    '!p{next}',
    '/^      shortcut=/{print; next}',
    '/android\\.(template|isGroupConversation)=/{print; next}',
    '/^                android\\./{m=($0 ~ /android\\.messages=/); next}',
    'm{print}'
  ].join(' ')
  return `dumpsys notification --noredact | awk ${quote(program)}`
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
  const state: PhoneState = { names: new Map(), profiled: new Set(), profileQueue: [], seen: new Set(), usedFiles: new Set(), pending: [], ticks: new Map(), lastOperationAt: 0, lastTicksAt: 0 }
  const files = (await readdir(dir()).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl')).sort().slice(-2)
  for (const name of files) {
    for (const line of (await readFile(path.join(dir(), name), 'utf8')).split('\n')) {
      if (!line) continue
      const record = JSON.parse(line) as { phone?: string; key?: string; file?: string; kind?: string; chat?: string; tick?: string; preview?: string }
      if (record.phone !== phone) continue
      if (record.key) state.seen.add(record.key)
      if (record.file) state.usedFiles.add(record.file)
      if (record.kind === 'tick' && record.chat && record.tick) state.ticks.set(`${record.chat}|${record.preview ?? ''}`, record.tick)
    }
  }
  const names = await readFile(path.join(dir(), `names-${phone}.json`), 'utf8').then(JSON.parse).catch(() => ({})) as Record<string, string>
  for (const [name, to] of Object.entries(names)) state.names.set(name, to)
  const profiled = await readFile(path.join(dir(), `profiled-${phone}.json`), 'utf8').then(JSON.parse).catch(() => []) as string[]
  for (const chat of profiled) state.profiled.add(chat)
  states.set(phone, state)
  return state
}

// Contract: PGW-28 — kept on disk until the backend accepts it; the event ID makes a resend harmless.
let outbox: Array<{ phone: string; event: BackendEvent }> | undefined
const outboxFile = () => path.join(dir(), 'outbox.json')

async function loadOutbox() {
  outbox ||= await readFile(outboxFile(), 'utf8').then(JSON.parse).catch(() => [])
  return outbox!
}

async function enqueue(phone: string, event: BackendEvent): Promise<void> {
  if (!config.backendEventsUrl) return
  const queue = await loadOutbox()
  queue.push({ phone, event })
  await mkdir(dir(), { recursive: true })
  await writeFile(outboxFile(), JSON.stringify(queue))
}

const PARK_AFTER_FAILURES = 10
let flushing = false
let failures = 0
async function flushOutbox(): Promise<void> {
  if (!config.backendEventsUrl || flushing) return
  flushing = true
  try {
    const queue = await loadOutbox()
    // Contract: PGW-28 — after a failure events go one by one, and one the backend keeps refusing is set
    // aside in parked.json so it cannot hold back every later message of that phone.
    if (failures >= PARK_AFTER_FAILURES && queue.length) {
      const parked = queue.shift()!
      await appendFile(path.join(dir(), 'parked.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...parked })}\n`)
      await writeFile(outboxFile(), JSON.stringify(queue))
      log.warn({ phone: parked.phone, eventId: parked.event.id, kind: parked.event.kind }, 'Phone event set aside after repeated backend failures')
      failures = 0
    }
    while (queue.length) {
      const phone = queue[0].phone
      const batch = queue.slice(0, failures ? 1 : 50).filter(item => item.phone === phone)
      const response = await fetch(config.backendEventsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ phone, events: batch.map(item => item.event) }),
        signal: AbortSignal.timeout(60_000)
      })
      await response.body?.cancel()
      if (!response.ok) {
        failures++
        throw new Error(`Backend returned ${response.status} for phone events`)
      }
      failures = 0
      queue.splice(0, batch.length)
      await writeFile(outboxFile(), JSON.stringify(queue))
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
    const notNow = find(nodes, { text: 'NOT NOW' })
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
  for (const row of findAll(nodes, { resourceId: 'com.whatsapp:id/contact_row_container' })) {
    const name = nodes.find(node => node.resourceId === 'com.whatsapp:id/conversations_row_contact_name' && inside(node, row))
    const icon = nodes.find(node => node.resourceId === 'com.whatsapp:id/status_indicator' && inside(node, row))
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
}

async function readProfile(device: PhysicalDevice, serial: string, state: PhoneState, item: { chat: string; phone: string }): Promise<void> {
  const pkg = whatsappPackage(device)
  let title: string | undefined
  let subtitle: string | undefined
  try {
    await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -a android.intent.action.VIEW -d ${quote(`https://api.whatsapp.com/send?phone=${item.phone}`)} -p ${quote(pkg)} >/dev/null`)
    let header: UiNode | undefined
    for (const until = Date.now() + 12_000; !header && Date.now() < until; await sleep(800)) {
      header = find(await dumpUi(serial), { resourceId: 'com.whatsapp:id/conversation_contact' })
    }
    if (!header) return
    await tap(serial, header)
    for (const until = Date.now() + 10_000; !title && Date.now() < until; await sleep(800)) {
      const nodes = await dumpUi(serial)
      title = find(nodes, { resourceId: 'com.whatsapp:id/contact_title' })?.text
      subtitle = find(nodes, { resourceId: 'com.whatsapp:id/contact_subtitle' })?.text
    }
  } finally {
    await shell(serial, 'input keyevent KEYCODE_BACK; input keyevent KEYCODE_HOME').catch(() => undefined)
    state.lastOperationAt = Date.now()
  }
  // The profile screen shows the saved name or the number as its title and "~ name" for the name the person set.
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

// Contract: PGW-25 — after a text send, customer bubbles below the bubble we just sent arrived while the chat
// was open. Other operations may leave the chat scrolled up, where older bubbles sit below ours, so they skip it.
export function chatCapture(device: Device, to: string, sentText: string): (serial: string) => Promise<void> {
  return async (serial: string) => {
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
    const statuses = findAll(nodes, { resourceId: 'com.whatsapp:id/status' })
    const dates = findAll(nodes, { resourceId: 'com.whatsapp:id/date' })
    const rowOf = (bubble: UiNode) => (node: UiNode) => node.bounds[1] >= bubble.bounds[1] - 20 && node.bounds[1] <= bubble.bounds[3] + 60
    const bubbles = findAll(nodes, { resourceId: 'com.whatsapp:id/message_text' })
    const own = bubbles.filter(bubble => statuses.some(rowOf(bubble))).sort((a, b) => b.bounds[3] - a.bounds[3])[0]
    if (!own || !sameText(own.text, sentText)) return
    const ownBottom = own.bounds[3]
    for (const bubble of bubbles.filter(item => item.bounds[1] > ownBottom && !statuses.some(rowOf(item)))) {
      const label = dates.find(rowOf(bubble))?.text || ''
      const key = `c|${to}|${label}|${bubble.text}`
      if (state.seen.has(key)) continue
      state.seen.add(key)
      await write(physical.phone, { kind: 'message', source: 'chat', key, chat: to, text: bubble.text, timeLabel: label })
      // The bubble arrived while the chat was open, so the capture time stands in for the minute label.
      await enqueue(physical.phone, messageEvent(key, `${to}@s.whatsapp.net`, { text: bubble.text, time: Date.now() }))
    }
  }
}

async function prune(): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const folder of [dir(), path.join(dir(), 'media')]) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const file = path.join(folder, name)
      const info = await stat(file)
      if (info.isFile() && info.mtimeMs < cutoff) await rm(file, { force: true })
    }
  }
}

async function tick(device: PhysicalDevice): Promise<void> {
  const state = await loadState(device.phone)
  await runOnDevice(device.phone, async () => {
    const serial = await connect(device)
    await pollNotifications(device, serial, state)
    await collectMedia(device, serial, state)
    const profile = state.profileQueue.shift()
    if (profile) await readProfile(device, serial, state, profile)
    const idle = Date.now() - state.lastOperationAt >= TICKS_EVERY_MS
    if (idle && Date.now() - state.lastTicksAt >= TICKS_EVERY_MS) {
      state.lastTicksAt = Date.now()
      await readTicks(device, serial, state)
    }
  })
}

export function startIncomingCapture(): void {
  const busy = new Set<string>()
  const offline = new Set<string>()
  const run = async () => {
    const devices = (JSON.parse(await readFile(config.devicesFile, 'utf8')) as Device[])
      .filter((device): device is PhysicalDevice => device.driver === 'physical' && device.captureIncoming !== false)
    for (const device of devices) {
      // A slow round must not stack up behind itself.
      if (busy.has(device.phone)) continue
      busy.add(device.phone)
      tick(device)
        .then(() => offline.delete(device.phone))
        .catch(error => {
          // An offline phone is reported by the watchdog (PGW-18); log the first miss only.
          if (!offline.has(device.phone)) log.warn({ err: error, phone: device.phone }, 'Incoming capture failed')
          offline.add(device.phone)
        })
        .finally(() => busy.delete(device.phone))
    }
  }
  setInterval(() => {
    run().catch(error => log.warn({ err: error }, 'Incoming capture round failed'))
    flushOutbox().catch(error => log.warn({ err: error }, 'Phone events not delivered to the backend yet'))
  }, POLL_EVERY_MS)
  setInterval(() => { prune().catch(() => undefined) }, 6 * 60 * 60 * 1000)
}
