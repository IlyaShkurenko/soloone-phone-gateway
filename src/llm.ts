import { config } from './config.js'

type Content = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]

export function llmAvailable(model: string): boolean {
  return !!config.llm.apiKey && !!model
}

export function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Model reply has no JSON object')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export async function askJson(model: string, system: string, text: string, screenshot?: Buffer): Promise<unknown> {
  const content: Content = screenshot && config.llm.screenshots
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } }]
    : text
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content }]
    }),
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`)
  const json = await response.json() as { choices?: { message?: { content?: string } }[] }
  const reply = json.choices?.[0]?.message?.content
  if (!reply) throw new Error('OpenRouter returned no content')
  return extractJson(reply)
}
