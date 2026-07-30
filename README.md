# Grok Companion for Codex

Use the local Grok CLI from Codex for structured code reviews, delegated coding
tasks, and tracked background jobs. One Codex-targeted plugin works in both
Codex CLI and Codex in the ChatGPT desktop app. The plugin can be submitted to
OpenAI's shared Plugins Directory, but its local-runtime requirement means it
is not a general ChatGPT connector.

This is the Codex-host counterpart to
[claude-plugin-grok](https://github.com/mmm1h/claude-plugin-grok). It is not the
similarly named [codex-plugin-grok](https://github.com/mmm1h/codex-plugin-grok),
which runs Codex from Grok Build.

## Requirements

- Node.js 18.18 or newer
- Grok CLI 0.2.0 or newer on `PATH`
- Grok authentication through `grok login`, `GROK_API_KEY`, `XAI_API_KEY`, or
  the user's configured Grok provider
- Git for review workflows

## Install

Add the public marketplace and install the plugin:

```text
codex plugin marketplace add https://github.com/mmm1h/codex-grok-companion.git
codex plugin add grok-companion@codex-grok-companion
```

Start a new Codex session after installation.

### Codex CLI

Run `codex`, enter `/plugins`, and confirm **Grok Companion** is installed and
enabled. Invoke a skill explicitly with `$grok-setup`, `$grok-review`,
`$grok-adversarial-review`, `$grok-delegate`, or `$grok-jobs`, or ask Codex in
natural language to consult Grok.

### ChatGPT desktop app

The desktop app and CLI share Codex's local plugin configuration.

1. Add the marketplace and plugin with the commands above.
2. Restart the ChatGPT desktop app.
3. Open **Codex > Plugins**, find **Grok Companion**, and enable it.
4. Start a new Codex chat before invoking a bundled skill.

Plugins are supported in Codex and ChatGPT Work surfaces in the desktop app,
not ordinary Chat, mobile, or the IDE extension.

## Skills

| Skill | Purpose |
| --- | --- |
| `$grok-setup` | Offline CLI, capability, and authentication readiness check |
| `$grok-review` | Structured read-only Git review |
| `$grok-adversarial-review` | Focused challenge of design and failure modes |
| `$grok-delegate` | Read-only or write-capable coding task delegation |
| `$grok-jobs` | Status, result, logs, wait, cancel, export, and cleanup |

Examples:

```text
$grok-setup
$grok-review review my working tree in the background
$grok-adversarial-review challenge the rollback and retry design
$grok-delegate investigate and fix the flaky authentication test
$grok-jobs show recent jobs
```

## Runtime Behavior

- Reviews always use Grok's read-only sandbox, a read-only tool allowlist, no
  subagents, and no web search.
- Reviews inline complete diffs up to 50 files and 512 KiB by default. Use
  `--inline-diff-max-files` and `--inline-diff-max-bytes` to tune those bounded
  limits; larger changes use the explicitly labeled self-collection mode.
- Delegated tasks are write-capable only when the user asks for implementation.
  Planning and diagnosis-only requests use read-only mode. The runtime also
  defaults to read-only if neither mode flag is supplied.
- User task and focus text travels through UTF-8 files rather than shell
  interpolation.
- Background work uses a detached Node worker with durable job records. It does
  not depend on the originating Codex chat staying open.
- Continuation is always explicit with `--resume-job <job-id>` or
  `--session-id <id>`. Both resolve only confirmed Grok task sessions in the
  current Git workspace; there is no implicit "resume latest" behavior.
- State defaults to
  `$CODEX_HOME/state/plugins/grok-companion/<workspace>-<hash>/`, or
  `~/.codex/state/plugins/grok-companion/...` when `CODEX_HOME` is unset.
  Host-provided `PLUGIN_DATA` takes precedence over `CODEX_HOME`, and
  `GROK_COMPANION_HOME` takes precedence over both. `$grok-setup` reports the
  effective directory and selector.
- Export a job explicitly with `result <job-id> --out <path>`. Exports contain
  the terminal job record, logs, and model output. Active jobs cannot be
  exported because their request is still needed by the detached worker.
  Prompt-bearing requests are removed from terminal records; those records
  retain the shortened prompt summary shown in status output. Logs and model
  results can still contain task text, diffs, repository content, or tool
  output and should be handled as potentially sensitive.
- Grok must finish with a successful stop reason. Cancellation, refusal,
  length limits, or any other non-success stop reason fails the command even
  when the Grok process itself exits with code zero.

## Data And Permissions

This plugin launches the user's local `grok` binary. Review evidence, task
prompts, and any files Grok reads are handled by the Grok CLI and the provider
configured by the user. The plugin does not collect telemetry or copy API keys.

Tracked job state is stored locally until explicit cleanup or automatic
pruning. The index retains at most 50 jobs and prunes only the oldest terminal
job artifacts; it never prunes active work. See the full
[Privacy Policy](plugins/grok-companion/PRIVACY.md),
[Terms of Service](plugins/grok-companion/TERMS.md), and
[Support Guide](plugins/grok-companion/SUPPORT.md).

Codex sandbox and approval policy governs the companion command. Grok then
applies its own sandbox and permission mode. Read-only runs use plan mode and a
strict tool allowlist. Explicit write runs use Grok's `acceptEdits` permission
mode without `--always-approve` or `bypassPermissions`. A write delegation can
modify the current checkout, so Codex must inspect the resulting diff and run
appropriate tests before accepting it.

## Direct Runtime

The skills wrap this portable entry point:

```text
node plugins/grok-companion/scripts/grok-companion.mjs --help
```

For example:

```text
node plugins/grok-companion/scripts/grok-companion.mjs setup --json
node plugins/grok-companion/scripts/grok-companion.mjs review --background
node plugins/grok-companion/scripts/grok-companion.mjs task --read-only --prompt-file request.md
node plugins/grok-companion/scripts/grok-companion.mjs task --write --prompt-file request.md
node plugins/grok-companion/scripts/grok-companion.mjs status --all
node plugins/grok-companion/scripts/grok-companion.mjs status <job-id> --logs 80
node plugins/grok-companion/scripts/grok-companion.mjs result <job-id> --out job.json
```

Direct `task` calls default to read-only. Write-capable execution requires an
explicit `--write`. Piped input is read only with `--stdin`.

## Development

```text
npm install
npm test
npm run test:store
npm run package:plugin
```

Tests use a fake Grok executable and do not require authentication or model
usage. Validate the plugin and skills before publishing:

```text
python <plugin-creator>/scripts/validate_plugin.py plugins/grok-companion
python <skill-creator>/scripts/quick_validate.py plugins/grok-companion/skills/grok-setup
```

`npm run package:plugin` creates a deterministic skills-only ZIP under
`dist/`. Store submission metadata, including five positive and three negative
review cases, lives in
[`plugins/grok-companion/store/submission.json`](plugins/grok-companion/store/submission.json).

## Attribution

The runtime derives from
[mmm1h/claude-plugin-grok](https://github.com/mmm1h/claude-plugin-grok). The
companion design was informed by
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). See
[NOTICE](NOTICE).

Apache-2.0. See [LICENSE](LICENSE).
