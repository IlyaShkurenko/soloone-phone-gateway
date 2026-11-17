---
paths:
  - "tests/**"
  - "**/*.test.*"
  - "**/*.spec.*"
---

# Tests

- A test proves a behavior a user or caller sees, named in plain words: `a duplicate Stripe webhook does not credit
  the wallet twice`. A regression test names the bug it reproduces.
- A new test must fail before the fix: `npm run fails-first -- <files>`.
- Fictional data only: emails at example.com or example.test, phones 447700900000 to 447700900999, invented names. No
  real customer, creator or phone number, no key, token or password. A value shaped like a key is joined at run time
  from parts, so the secret scan doesn't flag it.
- No network and no real vendor: inject a fake client, a fake clock and fake timers.
- A test reads nothing of the developer's machine (no `.env`, no home folder, no local database): it builds what it
  needs in a temporary folder or in memory, and gives the same result locally and in CI.
- A test that starts a server listens on 127.0.0.1 on a free port.
