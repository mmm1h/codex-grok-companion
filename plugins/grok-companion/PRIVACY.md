# Privacy Policy

Effective date: July 30, 2026

Grok Companion is a local Codex plugin published by mmm1h. It invokes the
`grok` command installed and configured by the user. This policy explains what
the plugin itself handles and where third-party processing occurs.

## Data processed

Depending on the command, the plugin may process:

- task instructions and optional review focus text;
- Git metadata, diffs, changed file names, and repository content made
  available to the local Grok CLI;
- Grok responses, execution status, session identifiers, timing information,
  and error messages;
- a shortened prompt summary used to identify tracked jobs; and
- local process metadata needed to monitor or cancel a background job.

Review prompts can contain complete Git diffs within the documented evidence
limits. In self-collection mode, and during delegated tasks, the Grok CLI may
read additional files permitted by its sandbox and the user's authorization.

## Processing and third parties

The plugin launches the user's local Grok CLI. Prompts, diffs, and other
repository content supplied to that CLI are sent to the Grok provider selected
and configured by the user. That provider processes and retains data under its
own terms and privacy policy. The publisher of this plugin does not operate
that provider and cannot delete provider-side copies.

OpenAI and Codex may process conversation content and plugin invocations under
their applicable terms and privacy notices. Grok Companion does not add its
own network service.

## Local storage and retention

The plugin stores tracked-job state, logs, results, and shortened prompt
summaries on the user's machine. Logs and model results can contain task text,
repository content, diffs, tool output, or other data processed during the
run. While a job is active, its local job record also contains the request
required by the detached worker. The top-level request is removed when the job
reaches a terminal state, but users should treat retained logs and results as
potentially prompt-bearing.

State is stored under the effective directory reported by `$grok-setup`.
`GROK_COMPANION_HOME`, `PLUGIN_DATA`, and `CODEX_HOME` can change that
location. The job index retains at most 50 jobs; when the limit is exceeded,
the oldest terminal job artifacts are removed. Active jobs are never removed
by automatic pruning.

Users can inspect retained data with `$grok-jobs`, export a terminal job with
`result <job-id> --out <path>`, and delete terminal job data with `cleanup`.
Cleanup requires an explicit age or count filter. Exported files remain under
the user's control and are not deleted by the plugin.

## Telemetry and credentials

Grok Companion does not collect publisher-operated analytics or telemetry. It
does not read, copy, log, or transmit API-key values. The offline setup check
only tests for non-empty authentication evidence and supported CLI flags.

## Security

Read-only review and investigation workflows use Grok's read-only mode and
tool restrictions. A delegated write task can modify the current checkout only
after the user has authorized implementation. Users should avoid placing
secrets in prompts or repositories made available to any model provider.

## Contact and changes

Privacy questions may be filed through the public support channel:
https://github.com/mmm1h/codex-grok-companion/issues

Security vulnerabilities should be reported privately as described in
[SECURITY.md](SECURITY.md). Material policy changes will be published in this
repository with an updated effective date.
