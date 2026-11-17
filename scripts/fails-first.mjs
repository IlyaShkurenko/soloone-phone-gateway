#!/usr/bin/env node
// Proves that new tests fail before the fix: each file given must fail, and on an assertion,
// not on a load error. Usage: npm run fails-first -- tests/a.test.ts tests/b.test.ts
// The test command comes from package.json "config.failsFirstCommand" (default below).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// pnpm passes the `--` separator through to the script; npm does not.
const files = process.argv.slice(2).filter((arg) => arg !== "--");
if (files.length === 0) {
  console.error("fails-first: name the new test files.");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const command = pkg.config?.failsFirstCommand || "node --import tsx --test";
const ASSERTION = /AssertionError|ERR_ASSERTION|expected .* to /;

let ok = true;
for (const file of files) {
  const run = spawnSync(`${command} ${JSON.stringify(file)}`, { shell: true, encoding: "utf8", env: { ...process.env, CI: "1" } });
  const out = `${run.stdout}\n${run.stderr}`;
  if (run.status === 0) {
    console.error(`STOP ${file}: passes on the current code, so it proves nothing yet.`);
    ok = false;
  } else if (!ASSERTION.test(out)) {
    console.error(`STOP ${file}: fails, but not on an assertion (load error or crash). Output:\n${out.slice(-2000)}`);
    ok = false;
  } else {
    console.log(`ok ${file}: fails on an assertion, as it should before the fix.`);
  }
}
process.exit(ok ? 0 : 1);
