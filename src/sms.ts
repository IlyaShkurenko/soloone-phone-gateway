// Contract: PGW-44–PGW-46 — SMS through the phone's own SIM. Sending goes through Google Messages, the default
// SMS app on the phones; the phone's SMS store (`content://sms`, readable from the ADB shell) confirms a send
// and gives the incoming ones.
import { quote, shell, sleep } from './adb.js'
import { SendFailure, SendUncertain } from './errors.js'
import { dumpUi, find, tap, type UiNode } from './ui.js'

const MESSAGES = 'com.google.android.apps.messaging'
const COMPOSE_FIELD = `${MESSAGES}:id/compose_message_text`
const CONFIRM_WAIT_MS = 30_000

// Telephony `type`: 1 inbox, 2 sent, 4 outbox, 5 failed, 6 queued.
export interface SmsRow { id: number; type: number; address: string; date: number; body: string }

// `content query` prints one "Row: N _id=…, …, body=…" line per row; body comes last, so it may hold commas and newlines.
export function parseSmsRows(output: string): SmsRow[] {
  return output.replace(/\r/g, '').split(/\n(?=Row: \d+ )/).flatMap(chunk => {
    const match = /^Row: \d+ _id=(\d+), type=(\d+), address=(.*?), date=(\d+), body=([\s\S]*)$/.exec(chunk.replace(/\n$/, ''))
    return match ? [{ id: Number(match[1]), type: Number(match[2]), address: match[3], date: Number(match[4]), body: match[5] }] : []
  }).sort((a, b) => a.id - b.id)
}

async function smsRows(serial: string, where: string): Promise<SmsRow[]> {
  return parseSmsRows(await shell(serial, `content query --uri content://sms --projection _id:type:address:date:body --where ${quote(where)}`, 30_000))
}

export async function lastSmsId(serial: string): Promise<number> {
  const output = await shell(serial, `content query --uri content://sms --projection _id --sort ${quote('_id DESC LIMIT 1')}`)
  return Number(/_id=(\d+)/.exec(output)?.[1] || 0)
}

export function inboxSmsAfter(serial: string, id: number): Promise<SmsRow[]> {
  return smsRows(serial, `type=1 AND _id>${id}`)
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
const samePhone = (address: string, to: string) => address.replace(/\D/g, '').slice(-9) === to.slice(-9)

async function openComposer(serial: string, to: string, text: string): Promise<UiNode[]> {
  await shell(serial, `am start -W -a android.intent.action.SENDTO -d ${quote(`smsto:+${to}`)} --es sms_body ${quote(text)} ${MESSAGES}`)
  for (let waited = 0; waited < 8000; waited += 1000) {
    const nodes = await dumpUi(serial)
    if (find(nodes, { resourceId: COMPOSE_FIELD })) return nodes
    await sleep(1000)
  }
  throw new SendFailure('The SMS composer did not open', true)
}

// Contract: PGW-44, PGW-45
export async function sendSms(serial: string, to: string, text: string, onSendPressed: () => Promise<void>): Promise<void> {
  const before = await lastSmsId(serial)
  await shell(serial, 'input keyevent KEYCODE_WAKEUP')
  let nodes = await openComposer(serial, to, text)
  // A draft left in that conversation can stand in place of our text: it is cleared and the composer opened again.
  if (!sameText(find(nodes, { resourceId: COMPOSE_FIELD })!.text, text)) {
    await tap(serial, find(nodes, { resourceId: COMPOSE_FIELD })!)
    await shell(serial, 'input keycombination 113 29; input keyevent KEYCODE_DEL; input keyevent KEYCODE_HOME')
    nodes = await openComposer(serial, to, text)
    if (!sameText(find(nodes, { resourceId: COMPOSE_FIELD })!.text, text)) throw new SendFailure('The SMS composer does not hold the text', true)
  }
  // With RCS chats on, the button sends an RCS chat message, which never reaches the SMS store.
  const send = find(nodes, { desc: 'Send SMS' })
  if (!send) throw new SendFailure('Google Messages would not send this as an SMS (RCS chats or MMS are on)', false)
  // Recorded before the tap: a crash in between leaves the attempt uncertain, never sent twice (PGW-3).
  await onSendPressed()
  await tap(serial, send)
  for (const started = Date.now(); Date.now() - started < CONFIRM_WAIT_MS; await sleep(1000)) {
    const row = (await smsRows(serial, `type!=1 AND _id>${before}`)).find(item => samePhone(item.address, to) && sameText(item.body, text))
    if (row?.type === 2) return
    if (row?.type === 5) throw new SendUncertain('The phone reported the SMS as failed')
  }
  throw new SendUncertain('The SMS was not confirmed as sent')
}
