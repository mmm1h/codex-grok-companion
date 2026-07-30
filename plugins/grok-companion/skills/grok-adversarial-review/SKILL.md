---
name: grok-adversarial-review
description: Run a structured, read-only Grok review that challenges implementation choices, assumptions, migrations, rollback safety, and failure modes with an optional custom focus. Use when the user asks Grok to pressure-test a design or requests a stronger, steerable review rather than a normal defect review.
---

# Grok Adversarial Review

Resolve `<plugin-root>` as two directories above the directory containing this
`SKILL.md`. Run:

```text
node "<plugin-root>/scripts/grok-companion.mjs" adversarial-review [options]
```

Use `--scope auto|working-tree|branch` and `--base <ref>` as requested. If the
user provides focus text, write it to a temporary UTF-8 file with a safe file
tool and pass its absolute path with `--focus-file`. Never interpolate user text
into a shell command. Remove the temporary file after the companion has loaded
it.

Forward `--inline-diff-max-files` and `--inline-diff-max-bytes` only when the
user explicitly asks to tune the evidence budget.

Use foreground execution for a clearly small review or when the user asks to
wait. Use the companion's `--background` flag for larger reviews or an explicit
background request. Do not shell-background the process.

This workflow is review-only. Return Grok's findings without applying fixes.
When a background job is queued, report its job ID and use `$grok-jobs` for
follow-up.
