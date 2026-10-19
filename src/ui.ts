import { shell, sleep } from './adb.js'

export interface UiNode {
  index: number
  resourceId: string
  text: string
  desc: string
  className: string
  clickable: boolean
  checked: boolean
  bounds: [number, number, number, number]
}

export interface Selector {
  resourceId?: string
  text?: string
  textContains?: string
  desc?: string
  descContains?: string
  descPattern?: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity] ?? match
  })
}

export function parseUiTree(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  for (const [, raw] of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const [, key, value] of raw.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[key] = decode(value)
    const b = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    nodes.push({
      index: nodes.length,
      resourceId: attrs['resource-id'] || '',
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      className: attrs.class || '',
      clickable: attrs.clickable === 'true',
      checked: attrs.checked === 'true',
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0]
    })
  }
  return nodes
}

// Popups such as the reaction tray live in their own window and need `allWindows`.
export async function dumpUi(serial: string, allWindows = false): Promise<UiNode[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const flag = allWindows ? '--windows ' : ''
    const xml = await shell(serial, `uiautomator dump ${flag}/sdcard/gw-ui.xml >/dev/null 2>&1; cat /sdcard/gw-ui.xml`, 30_000)
    if (xml.includes('<hierarchy')) return parseUiTree(xml)
    // The dump fails while the screen is animating.
    await sleep(700)
  }
  throw new Error('UI tree is not available')
}

export function matches(node: UiNode, selector: Selector): boolean {
  if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) return false
  if (selector.text !== undefined && node.text !== selector.text) return false
  if (selector.textContains !== undefined && !node.text.includes(selector.textContains)) return false
  if (selector.desc !== undefined && node.desc !== selector.desc) return false
  if (selector.descContains !== undefined && !node.desc.includes(selector.descContains)) return false
  if (selector.descPattern !== undefined && !new RegExp(selector.descPattern, 'i').test(node.desc)) return false
  return Object.keys(selector).length > 0
}

export function find(nodes: UiNode[], selector: Selector): UiNode | undefined {
  return nodes.find(node => matches(node, selector))
}

export function findAll(nodes: UiNode[], selector: Selector): UiNode[] {
  return nodes.filter(node => matches(node, selector))
}

function pointIn(node: UiNode): [number, number] {
  const [x1, y1, x2, y2] = node.bounds
  const jitter = (from: number, to: number) => Math.round(from + (to - from) * (0.3 + Math.random() * 0.4))
  return [jitter(x1, x2), jitter(y1, y2)]
}

// A press inside the middle of the element with a human-like duration.
export async function tap(serial: string, node: UiNode): Promise<void> {
  const [x, y] = pointIn(node)
  const duration = 70 + Math.floor(Math.random() * 80)
  await shell(serial, `input swipe ${x} ${y} ${x} ${y} ${duration}`)
}

// `input swipe` to the same point is not reliably a long press in WhatsApp; motion events are.
export async function longPress(serial: string, node: UiNode): Promise<void> {
  const [x, y] = pointIn(node)
  await shell(serial, `input motionevent DOWN ${x} ${y}; sleep 1.1; input motionevent UP ${x} ${y}`)
}

// Emoji may carry a variation selector in one place and not in another.
export const sameEmoji = (a: string, b: string) => a.replace(/️/g, '').trim() === b.replace(/️/g, '').trim()

// Compact listing for the LLM: only nodes that carry meaning or can be tapped.
export function describeTree(nodes: UiNode[]): string {
  return nodes
    .filter(node => node.text || node.desc || node.clickable || node.resourceId)
    .map(node => {
      const parts = [`#${node.index}`]
      if (node.resourceId) parts.push(`id=${node.resourceId.replace(/^.*:id\//, '')}`)
      if (node.text) parts.push(`text=${JSON.stringify(node.text.slice(0, 80))}`)
      if (node.desc) parts.push(`desc=${JSON.stringify(node.desc.slice(0, 100))}`)
      if (node.clickable) parts.push('clickable')
      if (node.checked) parts.push('checked')
      parts.push(`bounds=${node.bounds.join(',')}`)
      return parts.join(' ')
    })
    .join('\n')
}
