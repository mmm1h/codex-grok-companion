# Support

Grok Companion supports Codex CLI and Codex in the ChatGPT desktop app on a
machine that has:

- Node.js 18.18 or newer;
- Grok CLI 0.2.0 or newer with `--json-schema` and `--sandbox`;
- Git for review workflows; and
- valid authentication for the user's configured Grok provider.

It does not run in ordinary Chat, mobile, the IDE extension, or a hosted
environment without access to the user's local Grok CLI.

## Before filing an issue

1. Run `$grok-setup` or
   `node scripts/grok-companion.mjs setup --json` from the plugin root.
2. Confirm the plugin version, Node.js version, Grok CLI version, operating
   system, command used, and whether the failure is reproducible.
3. For a background job, include its status and a redacted log tail from
   `$grok-jobs`. Do not post API keys, credentials, proprietary prompts, source
   code, or unredacted model output.

File a support request at:
https://github.com/mmm1h/codex-grok-companion/issues

For vulnerabilities, do not open a public issue. Follow
[SECURITY.md](SECURITY.md).
