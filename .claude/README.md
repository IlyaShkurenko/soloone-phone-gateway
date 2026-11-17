# How agents work in this repository

The rules for every change are in AGENTS.md ("Quality and security gate"). This folder holds what enforces them.

## The flow for a change

The session you talk to is the **lead**. It plans the change and checks the work; for anything beyond a one-line fix
it does not write the tests and the code itself.

1. **test-writer** writes the tests for the behavior first, from what the change must do. It runs
   `npm run fails-first -- <test files>`: each new test must fail on the current code, on an assertion. A test that
   passes before the fix proves nothing.
2. **builder** writes the code until those tests and the whole gate pass. It does not edit the tests. If a test looks
   wrong, it stops and says so.
3. **diagnosis** (read-only) runs after a failing gate round and says whether the code or the test is wrong. At most
   three failing rounds, then the lead brings the options to the user.
4. **verifier** checks the finished change from a clean copy: the gate, the diff against the goal, swallowed errors,
   and that the builder did not touch the tests.
5. **security-reviewer** runs on changes to sign-in, sessions, payments, wallets and deposits, personal data,
   webhooks from outside, or secrets.
6. **critic** (read-only, 2 to 4 runs, one angle each) attacks the tests of a high-risk change: coverage, edge cases,
   whether an assertion can fail, flakiness. Not on ordinary changes.

A bug fix follows the same flow: the test writer first writes a test that reproduces the bug and fails.

## The guard

`.claude/hooks/guard.mjs` runs before every file and shell tool call. It refuses:

- reading, searching or writing `.env` files and key or credential files (`.env.example` is allowed);
- printing the whole environment;
- force pushes, `git reset --hard`, `git clean -f`, history rewrites, recursive deletes of a root, home or parent
  folder;
- database schema changes (`drizzle-kit push|migrate|generate`, `db:push`): AGENTS.md says to give the SQL in chat;
- piping a download into a shell.

If it blocks something you really need, run it yourself in your terminal.

## The gate

`npm run gate` (or `pnpm run gate`) is the one command that says a change is done. What it runs is in package.json;
CI runs the same command before every deploy.
