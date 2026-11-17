---
paths:
  - "src/**"
  - "app/**"
  - "server/**"
---

# Security

- Secrets come from the environment, read in one config module, by name. The names are in `.env.example` and
  SECURITY.md; the values never appear in code, tests, logs, errors, URLs or commits.
- Every route decides who may call it before it does any work. A user reaches only their own records; check the
  owner on the server, never trust an ID or a role sent by the client.
- Input is validated at the edge (zod or the framework's validator). No SQL, shell command or file path is built from
  raw input.
- Money: amounts come from the server's own records. A payment, deposit, refund or wallet change is idempotent: a
  retried webhook or a double click applies it once.
- A webhook from outside is accepted only after its signature or shared secret is checked.
- Logs: IDs and outcomes only. No tokens, passwords, message text, phone numbers or emails. Errors are logged by
  type and code, without the request body.
- Uploads: limited by type and size, stored under generated names.
- No `eval`, no `new Function`, no `child_process` with input from a request.
