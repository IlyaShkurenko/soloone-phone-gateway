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
  token: requireEnv('GATEWAY_TOKEN'),
  devicesFile: path.resolve(root, process.env.DEVICES_FILE || 'devices.json'),
  scriptsDir: path.resolve(root, process.env.SCRIPTS_DIR || 'scripts'),
  stateDir: path.resolve(root, process.env.STATE_DIR || 'state'),
  adbPath: process.env.ADB_PATH || 'adb',
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
  // Must stay below the backend's 150s request timeout (WA-PGW-4).
  requestDeadlineMs: 140_000,
  latestSendStartMs: 115_000
}
