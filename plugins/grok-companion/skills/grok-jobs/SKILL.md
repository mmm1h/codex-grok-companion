---
name: grok-jobs
description: Inspect and manage Grok Companion background jobs in the current workspace, including status, result, logs, wait, cancel, rerun, export, and cleanup. Use when the user asks about a queued Grok job, wants its output or logs, needs to stop it, or wants to manage retained Grok job history.
---

# Grok Jobs

Resolve `<plugin-root>` as two directories above the directory containing this
`SKILL.md`. Map the request to one companion command:

```text
node "<plugin-root>/scripts/grok-companion.mjs" status [job-id] [options]
node "<plugin-root>/scripts/grok-companion.mjs" result [job-id] [options]
node "<plugin-root>/scripts/grok-companion.mjs" logs [job-id] [options]
node "<plugin-root>/scripts/grok-companion.mjs" cancel [job-id] [options]
node "<plugin-root>/scripts/grok-companion.mjs" rerun [job-id] [options]
node "<plugin-root>/scripts/grok-companion.mjs" export <job-id> [options]
node "<plugin-root>/scripts/grok-companion.mjs" cleanup [options]
```

Use `status <job-id> --wait --with-result` when the user wants to wait for a
running job and receive its result. A wait timeout exits with code 124 while
leaving the job active.

Cancel only when the user requests cancellation. Run cleanup with `--dry-run`
unless the user explicitly authorizes pruning retained finished jobs. Validate
job IDs as letters, digits, and hyphens before placing them in a command; never
interpolate arbitrary user text.

Present the companion's result faithfully, including job ID, terminal status,
session ID, and recovery actions.
