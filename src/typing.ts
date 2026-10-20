import { quote, shell, sleep } from './adb.js'
import { SendFailure } from './errors.js'

const ADB_KEYBOARD = 'com.android.adbkeyboard/.AdbIME'
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/

function splitIntoPieces(text: string, pieces: number): string[] {
  const chars = Array.from(text)
  const size = Math.max(1, Math.ceil(chars.length / Math.max(1, pieces)))
  const result: string[] = []
  for (let index = 0; index < chars.length;) {
    // Uneven piece lengths read more like a person than a fixed rhythm.
    const length = Math.max(1, size + Math.round((Math.random() - 0.5) * size))
    const piece = chars.slice(index, index + length).join('')
    // `input text` drops a whitespace-only piece, so spaces always ride with a neighbour.
    if (result.length && (!piece.trim() || !result[result.length - 1].trim())) result[result.length - 1] += piece
    else result.push(piece)
    index += length
  }
  return result
}

async function hasAdbKeyboard(serial: string): Promise<boolean> {
  return (await shell(serial, 'pm list packages com.android.adbkeyboard')).includes('com.android.adbkeyboard')
}

export async function clearFocusedInput(serial: string, length: number): Promise<void> {
  await shell(serial, 'input keyevent KEYCODE_MOVE_END')
  for (let left = length + 5; left > 0; left -= 40) {
    await shell(serial, `input keyevent ${Array(Math.min(40, left)).fill('KEYCODE_DEL').join(' ')}`)
  }
}

// Contract: PGW-8 — without a typing time the text goes in as one piece: the phone round trips already
// take real time. With one, it is spread over that time in small pieces. The keyboard is restored after.
export async function typeText(serial: string, text: string, typingTimeMs = 0): Promise<void> {
  if (!text) return
  // Each adb round trip already costs time, so very long texts get fewer, larger pieces.
  const pieces = typingTimeMs > 0 ? Math.min(Array.from(text).length, Math.max(1, Math.floor(typingTimeMs / 350))) : 1
  const parts = splitIntoPieces(text, pieces)
  const pause = () => typingTimeMs > 0 ? sleep(Math.max(0, typingTimeMs / parts.length - 200) * (0.6 + Math.random() * 0.8)) : Promise.resolve()

  if (await hasAdbKeyboard(serial)) {
    const previous = (await shell(serial, 'settings get secure default_input_method')).trim()
    await shell(serial, `ime enable ${ADB_KEYBOARD} >/dev/null; ime set ${ADB_KEYBOARD} >/dev/null`)
    try {
      await sleep(400)
      for (const part of parts) {
        await shell(serial, `am broadcast -a ADB_INPUT_B64 --es msg ${quote(Buffer.from(part, 'utf8').toString('base64'))} >/dev/null`)
        await pause()
      }
    } finally {
      if (previous && previous !== 'null' && previous !== ADB_KEYBOARD) {
        await shell(serial, `ime set ${quote(previous)} >/dev/null`).catch(() => undefined)
      }
    }
    return
  }

  if (!ASCII_PRINTABLE.test(text)) throw new SendFailure('Non-ASCII text needs ADB Keyboard on the phone', false)
  for (const part of parts) {
    await shell(serial, `input text ${quote(part.replace(/ /g, '%s'))}`)
    await pause()
  }
}
