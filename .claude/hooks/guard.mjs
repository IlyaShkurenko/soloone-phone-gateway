#!/usr/bin/env node
// Claude Code PreToolUse guard. Reads the tool call as JSON on stdin; exit 2 refuses it and tells the agent why.
// It keeps secrets out of agent sessions and stops commands that can't be undone. See .claude/README.md.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const SAFE_ENV_SUFFIX = /\.(example|sample|template)$/i;
const SECRET_FILE = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.agent.local ...
  /\.(pem|key|p12|pfx|jks|keystore|mobileprovision|ovpn)$/i,
  /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /^(service-account|credentials|secrets?)([-_.].*)?\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

const REFUSED_COMMANDS = [
  [/\bgit\s+push\b[^\n;|&]*\s(--force|-f|--force-with-lease)\b/, "force push"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard (loses uncommitted work)"],
  [/\bgit\s+clean\s+-[a-z]*f/, "git clean -f (deletes untracked files)"],
  [/\bgit\s+(filter-branch|filter-repo)\b/, "rewriting git history"],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\.\.?\/?|\*)(\s|$)/, "recursive delete of a root, home or parent folder"],
  [/\bdrizzle-kit\s+(push|migrate|generate|drop|up)\b/, "database schema change (AGENTS.md: give the SQL in chat instead)"],
  [/\b(npm|pnpm|yarn)\s+(run\s+)?db:(push|generate|migrate)\b/, "database schema change (AGENTS.md: give the SQL in chat instead)"],
  [/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/, "piping a download into a shell"],
  [/^\s*(printenv|env|set|export\s+-p)\s*$/m, "printing the whole environment (it holds secrets)"],
];

function refuse(why) {
  process.stderr.write(`Refused by .claude/hooks/guard.mjs: ${why}\n`);
  process.exit(2);
}

function isSecretFile(path) {
  const name = basename(String(path || ""));
  if (!name || SAFE_ENV_SUFFIX.test(name)) return false;
  return SECRET_FILE.some((re) => re.test(name));
}

// A word in a shell command that names a secret file: `.env`, `./.env.local`, `"$DIR/.env"`, `<.env`.
function commandTouchesSecretFile(command) {
  const words = command.split(/[\s;|&<>()'"`=]+/).filter(Boolean);
  return words.find((w) => isSecretFile(w.replace(/[,:]+$/, "")));
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // not a tool call we can read; let Claude Code decide
}
const tool = input.tool_name || "";
const args = input.tool_input || {};

if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const path = args.file_path || args.notebook_path || "";
  if (isSecretFile(path)) refuse(`${basename(path)} holds secrets. Use the .example file for variable names.`);
}

if (tool === "Grep") {
  if (isSecretFile(args.path)) refuse("searching inside a secret file");
  if (args.glob && /(^|\/)\.env(\*|$|\.(?!example|sample|template))/i.test(args.glob)) refuse("searching inside .env files");
}

if (tool === "Bash") {
  const command = String(args.command || "");
  const hit = commandTouchesSecretFile(command);
  if (hit) refuse(`the command names ${basename(hit)}, which holds secrets. Use the .example file for variable names.`);
  for (const [re, why] of REFUSED_COMMANDS) if (re.test(command)) refuse(`${why}. Ask the user to run it if it is really needed.`);
}

process.exit(0);
