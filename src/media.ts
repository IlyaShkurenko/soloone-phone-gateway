import { execFile } from 'node:child_process'
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

function ffmpeg(args: string[]): Promise<boolean> {
  return new Promise(resolve => execFile(config.ffmpegPath, ['-y', '-loglevel', 'error', ...args], { timeout: 90_000 }, error => resolve(!error)))
}

// AICODE-NOTE: WhatsApp opens its media composer (and View Once) only for videos it recognises;
// a QuickTime .mov is offered as a plain file share instead, which would send it without View Once.
async function toMp4(input: string, output: string): Promise<void> {
  if (await ffmpeg(['-i', input, '-c', 'copy', '-movflags', '+faststart', output])) return
  if (await ffmpeg(['-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', output])) return
  throw new SendFailure('This video format cannot be sent from the phone', false)
}

// AICODE-NOTE: Large PNG photos (5.5 MB screenshots) stayed "Pending" and then "Retry" in WhatsApp on
// the cloud phone, while JPEG photos and 14 MB videos uploaded fine. WhatsApp sends photos as JPEG
// anyway, so convert everything that is not JPEG first.
async function toJpeg(input: string, output: string): Promise<void> {
  if (await ffmpeg(['-i', input, '-frames:v', '1', '-q:v', '3', '-pix_fmt', 'yuvj420p', output])) return
  throw new SendFailure('This photo format cannot be sent from the phone', false)
}

// The file name is derived from the backend message ID, so it is safe inside device shell quotes.
export async function stageMedia(serial: string, messageId: string, media: {
  type: 'image' | 'video'; url: string; fileName: string; mimeType?: string
}): Promise<StagedMedia> {
  const sourceMime = mimeFor(media.type, media.mimeType, media.fileName)
  const mimeType = media.type === 'video' ? 'video/mp4' : 'image/jpeg'
  const base = `soloone-${messageId.replace(/[^\w-]/g, '')}`
  const name = `${base}.${EXTENSIONS[mimeType]}`
  const localDir = path.join(config.stateDir, 'tmp')
  const sourcePath = path.join(localDir, `${base}.source.${EXTENSIONS[sourceMime]}`)
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
  await writeFile(sourceMime === mimeType ? localPath : sourcePath, bytes)
  const cleanup = async () => {
    await rm(localPath, { force: true })
    await rm(sourcePath, { force: true })
    await shell(serial, `rm -f ${quote(remotePath)}; am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${quote(`file://${remotePath}`)} >/dev/null`).catch(() => undefined)
  }
  try {
    if (sourceMime !== mimeType) await (media.type === 'video' ? toMp4 : toJpeg)(sourcePath, localPath)
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
