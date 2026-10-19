import type { UiNode } from './ui.js'

const FORBIDDEN_IDS = /:id\/(send|voice_note_btn|camera_btn|input_attach_button|conversations_row\w*|contact_row\w*|menuitem_\w*call\w*)$/
const FORBIDDEN_LABELS = /\b(send|record|voice message|video call|voice call|call|camera|delete|block|report|clear chat|exit group|unlink|log ?out|uninstall)\b/i

// Contract: PGW-6 — recovery may only tap harmless clickable nodes.
export function recoveryTapRefusal(node: UiNode, nodes: UiNode[]): string | null {
  if (!node.clickable) return 'node is not clickable'
  if (FORBIDDEN_IDS.test(node.resourceId)) return 'node is a send, recording, call, attachment or chat-list control'
  if (FORBIDDEN_LABELS.test(node.text) || FORBIDDEN_LABELS.test(node.desc)) return 'node label is a sending or destructive action'
  // The audio share dialog sends immediately on OK.
  const shareDialog = nodes.some(item => item.resourceId === 'android:id/message' && /^share with/i.test(item.text))
  if (shareDialog && node.resourceId === 'android:id/button1') return 'OK in a share dialog sends the message'
  return null
}
