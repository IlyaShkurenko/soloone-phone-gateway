import dotenv from 'dotenv'
import path from 'node:path'

dotenv.config()

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const root = process.cwd()

export const config = {
  port: parseInt(process.env.PORT || '4010', 10),
  // Only the backend on the same host should reach the gateway.
  host: process.env.HOST || '127.0.0.1',
  token: requireEnv('GATEWAY_TOKEN'),
  devicesFile: path.resolve(root, process.env.DEVICES_FILE || 'devices.json'),
  scriptsDir: path.resolve(root, process.env.SCRIPTS_DIR || 'scripts'),
  stateDir: path.resolve(root, process.env.STATE_DIR || 'state'),
  adbPath: process.env.ADB_PATH || 'adb',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  multilogin: {
    apiUrl: (process.env.MULTILOGIN_API_URL || 'https://api.multilogin.com').replace(/\/$/, ''),
    token: process.env.MULTILOGIN_TOKEN?.trim() || '',
    // Used only when MULTILOGIN_TOKEN is empty.
    xcliPath: process.env.MULTILOGIN_XCLI_PATH || path.join(process.env.HOME || '', 'mlx/deps/cli/xcli'),
    // ADB stays on between sends only this long; 0 keeps it on.
    adbIdleDisableMs: parseInt(process.env.ADB_IDLE_DISABLE_MS || '600000', 10)
  },
  llm: {
    apiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
    recoveryModel: process.env.GATEWAY_RECOVERY_MODEL?.trim() || '',
    fixerModel: process.env.GATEWAY_FIXER_MODEL?.trim() || '',
    screenshots: process.env.LLM_SCREENSHOTS !== 'false'
  },
  // Offline alerts for physical phones (PGW-18); without both values alerts are only logged.
  alerts: {
    email: process.env.ALERT_EMAIL?.trim() || '',
    resendApiKey: process.env.RESEND_API_KEY?.trim() || '',
    from: process.env.ALERT_FROM?.trim() || 'SoloOne <support@solo1.ai>'
  },
  // A UI snapshot is reused this long when nothing was done on the phone; 0 disables the cache.
  uiSnapshotCacheMs: parseInt(process.env.UI_SNAPSHOT_CACHE_MS || '5000', 10),
  // Must stay below the backend's 150s request timeout (WA-PGW-4).
  requestDeadlineMs: 140_000,
  latestSendStartMs: 115_000
}
