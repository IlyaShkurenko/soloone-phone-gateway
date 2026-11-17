#!/usr/bin/env node
// Secret scan for the gate: gitleaks over the git history and over uncommitted changes, redacted.
// gitleaks comes from $GITLEAKS or the PATH (macOS: `brew install gitleaks`). In CI a missing gitleaks fails the gate;
// on a laptop it prints NOT RUN so nobody mistakes a skipped scan for a clean one.
// Known false positives are allowed in .gitleaks.toml, each with a reason.
import { spawnSync } from "node:child_process";

const bin = process.env.GITLEAKS || "gitleaks";
const probe = spawnSync(bin, ["version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  if (process.env.CI) {
    console.error("secret-scan: gitleaks not found in CI. Install it before the gate.");
    process.exit(1);
  }
  console.warn("secret-scan: NOT RUN (gitleaks not installed: brew install gitleaks). CI still runs it.");
  process.exit(0);
}
const runs = [
  ["history", ["git", "--redact", "--no-banner", "--exit-code", "1", "."]],
  ["staged changes", ["git", "--staged", "--redact", "--no-banner", "--exit-code", "1", "."]],
  ["unstaged changes", ["git", "--pre-commit", "--redact", "--no-banner", "--exit-code", "1", "."]],
];
let ok = true;
for (const [what, args] of runs) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`secret-scan: findings in ${what} (values redacted above). Remove the secret and rotate it; never allow a real one.`);
    ok = false;
  }
}
if (ok) console.log("secret-scan: clean (history, staged and unstaged changes).");
process.exit(ok ? 0 : 1);
