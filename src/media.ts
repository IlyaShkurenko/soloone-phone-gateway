import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { adb, quote, shell, sleep } from './adb.js'
import { config } from './config.js'
import { SendFailure } from './errors.js'

const MAX_BYTES = 64 * 1024 * 1024
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov'
}

export interface StagedMedia {
  remotePath: string
  contentUri: string
  mimeType: string
  cleanup: () => Promise<void>
}

function mimeFor(type: 'image' | 'video', mimeType: string | undefined, fileName: string): string {
  if (mimeType && EXTENSIONS[mimeType]) return mimeType
  const extension = path.extname(fileName).slice(1).toLowerCase()
  const known = Object.entries(EXTENSIONS).find(([, value]) => value === extension)?.[0]
  return known || (type === 'image' ? 'image/jpeg' : 'video/mp4')
}

// The file name is derived from the backend message ID, so it is safe inside device shell quotes.
export async function stageMedia(serial: string, messageId: string, media: {
  type: 'image' | 'video'; url: string; fileName: string; mimeType?: string
}): Promise<StagedMedia> {
  const mimeType = mimeFor(media.type, media.mimeType, media.fileName)
  const name = `soloone-${messageId.replace(/[^\w-]/g, '')}.${EXTENSIONS[mimeType]}`
  const localDir = path.join(config.stateDir, 'tmp')
  const localPath = path.join(localDir, name)
  const remotePath = `/sdcard/Download/${name}`

  let response: Response
  try {
    response = await fetch(media.url, { signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new SendFailure('Could not download the media file', true)
  }
  if (!response.ok) throw new SendFailure(`Media download failed (HTTP ${response.status})`, response.status >= 500)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new SendFailure('Media file is empty or too large', false)

  await mkdir(localDir, { recursive: true })
  await writeFile(localPath, bytes)
  const cleanup = async () => {
    await rm(localPath, { force: true })
    await shell(serial, `rm -f ${quote(remotePath)}; am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${quote(`file://${remotePath}`)} >/dev/null`).catch(() => undefined)
  }
  try {
    await adb(['-s', serial, 'push', localPath, remotePath], 120_000)
    await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${quote(`file://${remotePath}`)} >/dev/null`)
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(700)
      const row = await shell(serial, `content query --uri content://media/external/file --projection _id --where "_display_name='${name}'"`)
      const id = row.match(/_id=(\d+)/)?.[1]
      if (id) return { remotePath, contentUri: `content://media/external/file/${id}`, mimeType, cleanup }
    }
    throw new SendFailure('The phone did not index the media file', true)
  } catch (error) {
    await cleanup()
    throw error
  }
}
