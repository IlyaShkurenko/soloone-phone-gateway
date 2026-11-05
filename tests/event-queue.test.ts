import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { EventQueue } = await import('../src/event-queue.js')

const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'gw-events-')), 'events.sqlite')
const ids = (batch: { events: Array<{ id: string }> } | undefined) => batch?.events.map(event => event.id)

// Contract: PGW-40 — the old outbox removed the first N events of any phone after sending N of one phone.
test('events of other phones are never dropped when one phone is sent', () => {
  const queue = new EventQueue(fresh())
  queue.add('p41', { id: 'a1' }); queue.add('p6', { id: 'b1' }); queue.add('p41', { id: 'a2' })
  const first = queue.next()!
  assert.deepEqual([first.phone, ids(first)], ['p41', ['a1', 'a2']])
  queue.sent(ids(first)!)
  assert.deepEqual(ids(queue.next()), ['b1'])
})

test('an event recorded while a batch is in flight stays queued', () => {
  const queue = new EventQueue(fresh())
  queue.add('p41', { id: 'message' })
  const inFlight = queue.next()!
  queue.add('p41', { id: 'profile' })
  queue.sent(ids(inFlight)!)
  assert.deepEqual(ids(queue.next()), ['profile'])
})

test('an unavailable backend is retried with growing pauses and never sets an event aside', () => {
  const queue = new EventQueue(fresh())
  queue.add('p41', { id: 'e1' })
  let now = 1_000_000
  for (let attempt = 0; attempt < 40; attempt++) {
    assert.deepEqual(queue.failed(['e1'], 'HTTP 503', false, now), [])
    assert.equal(queue.next(now), undefined, 'waits its pause')
    now += 10 * 60_000
  }
  assert.deepEqual(ids(queue.next(now)), ['e1'])
  assert.equal(queue.counts().parked, undefined)
})

test('a refused batch is split and only the event refused alone is parked', () => {
  const queue = new EventQueue(fresh())
  for (const id of ['bad', 'ok1', 'ok2']) queue.add('p41', { id })
  let now = 1_000_000
  queue.failed(ids(queue.next(now))!, 'HTTP 400', true, now)
  assert.deepEqual(ids(queue.next(now)), ['bad'], 'goes alone at once')
  // Refused once in the batch and twice alone: three refusals set it aside.
  for (let refusal = 2; refusal <= 3; refusal++) {
    const parked = queue.failed(['bad'], 'HTTP 400', true, now)
    assert.deepEqual(parked, refusal === 3 ? ['bad'] : [])
    now += 10 * 60_000
  }
  assert.deepEqual(ids(queue.next(now)), ['ok1', 'ok2'])
  assert.equal(queue.requeueParked(), 1)
})

test('events survive a restart and a repeated event is kept once', () => {
  const file = fresh()
  const before = new EventQueue(file)
  before.add('p41', { id: 'e1', kind: 'message' }); before.add('p41', { id: 'e1', kind: 'message' })
  before.close()
  const after = new EventQueue(file)
  assert.deepEqual(after.next()?.events, [{ id: 'e1', kind: 'message' }])
})

test('the earlier JSON outbox is imported once, in order', () => {
  const file = fresh()
  const legacy = path.join(path.dirname(file), 'outbox.json')
  writeFileSync(legacy, JSON.stringify([{ phone: 'p41', event: { id: 'x1' } }, { phone: 'p41', event: { id: 'x2' } }]))
  const queue = new EventQueue(file)
  assert.equal(queue.importLegacy(legacy), 2)
  assert.equal(existsSync(legacy), false)
  assert.equal(queue.importLegacy(legacy), 0)
  assert.deepEqual(ids(queue.next()), ['x1', 'x2'])
})
