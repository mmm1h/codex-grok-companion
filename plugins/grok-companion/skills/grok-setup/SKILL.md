---
name: grok-setup
description: Check whether the local Grok CLI, required headless flags, Node.js runtime, and offline authentication evidence are ready for Grok Companion. Use when installing or troubleshooting the plugin, when Grok commands fail, or when the user asks to verify Grok readiness without spending model usage.
---

# Grok Setup

Resolve `<plugin-root>` as two directories above the directory containing this
`SKILL.md`.

Run:

```text
node "<plugin-root>/scripts/grok-companion.mjs" setup --json
```

Present the readiness result and concrete next steps. Setup is offline: do not
send a model prompt, probe an API, print credential values, or claim that a bare
config file proves authentication.

The supported baseline is Node.js 18.18 or newer and a Grok CLI that exposes
`--json-schema` and `--sandbox`. When authentication is not ready, direct the
user to `grok login` or their configured API-key environment variable.
