import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

process.env.GATEWAY_TOKEN ||= 'test-token'
const { parseUiTree, find, matches } = await import('../src/ui.js')
const { recoveryTapRefusal } = await import('../src/safety.js')
const { validateScript } = await import('../src/scripts.js')

const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="com.whatsapp:id/conversation_contact_name" class="android.widget.TextView" content-desc="" clickable="false" checked="false" bounds="[350,138][788,219]" />
<node index="1" text="Tom &amp; Jerry &quot;quoted&quot; &#128512;" resource-id="com.whatsapp:id/message_text" class="android.widget.TextView" content-desc="" clickable="false" checked="false" bounds="[200,600][900,700]" />
<node index="2" text="" resource-id="com.whatsapp:id/send" class="android.widget.ImageButton" content-desc="Send" clickable="true" checked="false" bounds="[1068,2416][1236,2584]" />
<node index="3" text="" resource-id="com.whatsapp:id/voice_note_btn" class="android.widget.ImageButton" content-desc="Voice message, Button." clickable="true" checked="false" bounds="[1064,2426][1232,2594]" />
<node index="4" text="OK" resource-id="com.whatsapp:id/vo_sp_bottom_sheet_ok_button" class="android.widget.Button" content-desc="" clickable="true" checked="false" bounds="[70,2192][1194,2360]" />
<node index="5" text="" resource-id="com.whatsapp:id/view_once_toggle" class="android.widget.ImageView" content-desc="Turn off view once" clickable="true" checked="false" bounds="[1068,2192][1236,2360]" />
<node index="6" text="" resource-id="com.whatsapp:id/conversations_row_contact_name" class="android.widget.TextView" content-desc="" clickable="true" checked="false" bounds="[0,300][1264,400]" />
</hierarchy>`

// Contract: PGW-5
test('UI tree parser decodes entities and bounds', () => {
  const nodes = parseUiTree(xml)
  assert.equal(nodes.length, 7)
  assert.equal(nodes[1].text, 'Tom & Jerry "quoted" 😀')
  assert.deepEqual(nodes[2].bounds, [1068, 2416, 1236, 2584])
  assert.equal(nodes[2].clickable, true)
})

// Contract: PGW-5
test('WhatsApp Business resource ids match the regular WhatsApp selectors', () => {
  const nodes = parseUiTree(`<node text="" resource-id="com.whatsapp.w4b:id/send" class="android.widget.ImageButton" content-desc="Send" clickable="true" bounds="[1,1][2,2]" />`)
  assert.equal(find(nodes, { resourceId: 'com.whatsapp:id/send' })?.desc, 'Send')
})

// Contract: PGW-5
test('selectors require every given field and never match an empty selector', () => {
  const nodes = parseUiTree(xml)
  assert.equal(find(nodes, { resourceId: 'com.whatsapp:id/view_once_toggle', desc: 'Turn off view once' })?.index, 5)
  assert.equal(find(nodes, { resourceId: 'com.whatsapp:id/view_once_toggle', desc: 'Turn on view once' }), undefined)
  assert.equal(find(nodes, { descPattern: '^voice message' })?.index, 3)
  assert.equal(matches(nodes[0], {}), false)
})

// Contract: PGW-6
test('recovery may not tap send, recording, chat rows or the share confirmation', () => {
  const nodes = parseUiTree(xml)
  assert.match(recoveryTapRefusal(nodes[2], nodes) || '', /send/)
  assert.ok(recoveryTapRefusal(nodes[3], nodes))
  assert.ok(recoveryTapRefusal(nodes[6], nodes))
  assert.match(recoveryTapRefusal(nodes[0], nodes) || '', /not clickable/)
  assert.equal(recoveryTapRefusal(nodes[4], nodes), null)
  const dialog = parseUiTree(`<node text="Share with Tom?" resource-id="android:id/message" clickable="false" bounds="[0,0][1,1]" />
<node text="OK" resource-id="android:id/button1" clickable="true" bounds="[0,0][1,1]" />`)
  assert.match(recoveryTapRefusal(dialog[1], dialog) || '', /share dialog/)
})

// Contract: PGW-7
test('fix proposals keep guarded steps in order and use known steps only', async () => {
  const base = validateScript(JSON.parse(await readFile('scripts/send_text.json', 'utf8')))
  const fixed = structuredClone(base)
  fixed.steps[4].target = { descPattern: '^Send$' }
  fixed.steps.splice(1, 0, { op: 'dismiss_if_present', target: { text: 'Not now' } })
  assert.equal(validateScript(fixed, base).steps.length, base.steps.length + 1)

  const withoutCheck = structuredClone(base)
  withoutCheck.steps = withoutCheck.steps.filter(step => step.op !== 'check_recipient')
  assert.throws(() => validateScript(withoutCheck, base), /guarded/)

  const reordered = structuredClone(base)
  const sendIndex = reordered.steps.findIndex(step => step.op === 'send')
  const [send] = reordered.steps.splice(sendIndex, 1)
  reordered.steps.unshift(send)
  assert.throws(() => validateScript(reordered, base), /guarded/)

  assert.throws(() => validateScript({ ...base, steps: [...base.steps, { op: 'shell', command: 'rm -rf /' }] }, base), /unknown op/)
  assert.throws(() => validateScript({ ...base, steps: [...base.steps, { op: 'tap', target: { bounds: '1,2' } }] }, base), /selector/)
})

// Contract: PGW-5
test('shipped scripts are valid', async () => {
  for (const name of ['send_text', 'send_media']) {
    validateScript(JSON.parse(await readFile(`scripts/${name}.json`, 'utf8')))
  }
})

const { parseNotifications, mediaKind, classifyTick } = await import('../src/incoming.js')

// Shape of the phone-side filtered dump, taken from port41 on 2026-11-03.
const notificationDump = `@@record
                android.template=String (android.app.Notification$InboxStyle)
      shortcut=253197079818371@lid found valid? true
@@record
                android.template=String (android.app.Notification$MessagingStyle)
                  [0] Bundle[{extras=Bundle[{}], sender_person=android.app.Person@17823278, sender=Mr Ill, text=Hello, dear, time=1793712810000}]
                  [1] Bundle[{extras=Bundle[{}], sender_person=android.app.Person@1ee144d, sender=Mr Ill, uri=content://com.whatsapp.provider.media/item/84aac76b, text=📷 Sent a photo, time=1793712818000, type=image/jpeg}]
                  [2] Bundle[{extras=Bundle[{}], sender_person=android.app.Person@806a21fe, sender=Mr Ill, text=two
lines, time=1793712821000}]
                  [3] Bundle[{extras=Bundle[{}], sender=null, text=our reply, time=1793712830000}]
                android.isGroupConversation=Boolean (false)
      shortcut=253197079818371@lid found valid? true
@@record
                android.template=String (android.app.Notification$MessagingStyle)
                  [0] Bundle[{extras=Bundle[{}], sender_person=android.app.Person@1, sender=Ann, text=group hello, time=1793712840000}]
                android.isGroupConversation=Boolean (true)
      shortcut=120363000000000000@g.us found valid? true
`

// Contract: PGW-23
test('notification messages are read per message, skipping summaries, groups and our own lines', () => {
  const messages = parseNotifications(notificationDump)
  assert.deepEqual(messages.map(message => [message.chat, message.sender, message.text, message.time]), [
    ['253197079818371@lid', 'Mr Ill', 'Hello, dear', 1793712810000],
    ['253197079818371@lid', 'Mr Ill', '📷 Sent a photo', 1793712818000],
    ['253197079818371@lid', 'Mr Ill', 'two\nlines', 1793712821000]
  ])
  assert.equal(messages[1].mimeType, 'image/jpeg')
})

// Contract: PGW-24
test('notification text tells the media type', () => {
  const kind = (text: string, mimeType?: string) => mediaKind({ chat: 'x', sender: 'y', text, time: 0, mimeType })
  assert.equal(kind('📷 Sent a photo', 'image/jpeg'), 'image')
  assert.equal(kind('🎥 Video'), 'video')
  assert.equal(kind('🎤 Voice message (0:05)'), 'voice')
  assert.equal(kind('Hello'), undefined)
})

// Contract: PGW-26
test('a tick icon is classified by colour and width', () => {
  const icon = (width: number, height: number, ink: [number, number, number], from: number, to: number) => {
    const rgb = Buffer.alloc(width * height * 3, 20)
    for (let y = 10; y < 20; y++) for (let x = from; x < to; x++) rgb.set(ink, (y * width + x) * 3)
    return rgb
  }
  assert.equal(classifyTick(icon(50, 30, [72, 164, 235], 5, 45), 50).tick, 'read')
  assert.equal(classifyTick(icon(50, 30, [140, 150, 155], 5, 45), 50).tick, 'delivered')
  assert.equal(classifyTick(icon(50, 30, [140, 150, 155], 15, 35), 50).tick, 'sent')
  assert.equal(classifyTick(Buffer.alloc(50 * 30 * 3, 20), 50).tick, 'unknown')
})

const { mediaCaption } = await import('../src/incoming.js')

// Contract: PGW-28
test("WhatsApp's media placeholder is not a caption", () => {
  assert.equal(mediaCaption('📷 Sent a photo'), undefined)
  assert.equal(mediaCaption('📷 Photo'), undefined)
  assert.equal(mediaCaption('🎤 Voice message (0:05)'), undefined)
  assert.equal(mediaCaption('📷 Look at this'), 'Look at this')
})
