---
name: grok-review
description: Run a structured, read-only Grok code review of the current Git working tree or branch comparison. Use when the user asks Grok to review changes, wants a second-opinion code review, or requests a background Grok review. Use grok-adversarial-review instead when the user supplies a custom risk or design focus.
---

# Grok Review

Resolve `<plugin-root>` as two directories above the directory containing this
`SKILL.md`. Run the companion from the repository being reviewed:

```text
node "<plugin-root>/scripts/grok-companion.mjs" review [options]
```

Use `--scope auto|working-tree|branch` and `--base <ref>` only when the request
requires them. Forward `--model` and `--timeout-ms` only when explicitly chosen.
Forward `--inline-diff-max-files` and `--inline-diff-max-bytes` only when the
user explicitly asks to tune the evidence budget.
Do not add focus text; route focused challenges to `$grok-adversarial-review`.

Use foreground execution for a clearly small review or when the user asks to
wait. Use the companion's `--background` flag for larger reviews or an explicit
background request. Do not shell-background the process.

This workflow is review-only. The runtime constrains Grok to a read-only
sandbox and read-only tools. Return the findings without editing files. When a
background job is queued, report its job ID and use `$grok-jobs` for follow-up.
