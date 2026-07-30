---
name: grok-delegate
description: Delegate a coding task, investigation, implementation, refactor, research request, or follow-up to the local Grok CLI with foreground or tracked background execution and optional session resume. Use when the user asks Codex to consult or hand work to Grok, or when an independent Grok pass is useful. Do not use for ordinary Grok code review; use grok-review or grok-adversarial-review.
---

# Delegate To Grok

Resolve `<plugin-root>` as two directories above the directory containing this
`SKILL.md`. Invoke:

```text
node "<plugin-root>/scripts/grok-companion.mjs" task [options]
```

## Prepare The Request

Write the task body to a temporary UTF-8 file with a safe file tool and pass its
absolute path with `--prompt-file`. Never interpolate user text into a shell
command. Remove the temporary file after the companion has loaded it.

Use `--read-only` for planning, research, diagnosis without fixes, or any
request that forbids edits. Use `--write` only when the user's request already
authorizes implementation or file changes. Do not broaden that authority. If
neither flag is supplied, the runtime defaults to read-only.

Tasks are fresh by default; `--fresh` may be used to make that intent explicit.
Continue prior Grok work only with an explicit `--resume-job <job-id>` or
`--session-id <id>` supplied from a relevant job result. Never infer or select
the latest session. Forward model, effort, and timeout choices only when
specified.

## Choose Execution

Use foreground execution for bounded tasks where the result is needed now.
Use `--background` for long investigations, multi-file implementation, or an
explicit background request. Do not shell-background the process.

For a foreground write task, inspect the resulting diff and run proportionate
tests before accepting Grok's work. Grok output is evidence, not verification.
For a queued task, report its job ID and use `$grok-jobs` to monitor, retrieve,
or cancel it.
