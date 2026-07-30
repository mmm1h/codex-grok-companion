#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  getGrokAuthStatus,
  getGrokAvailability,
  getGrokCapabilities,
  grokStopReasonError,
  isGrokAuthReady,
  parseGrokStructuredOutput,
  runGrokHeadless
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  cancelTrackedJob,
  cancelTrackedJobsParallel,
  cleanupJobs,
  DEFAULT_LOG_TAIL_LINES,
  exportJobBundle,
  finalizeCancelledJob,
  readJobLogs,
  readStoredJob,
  reconcileSessionJobs,
  resolveCancelableJob,
  resolveCancelableJobs,
  resolveResultJob,
  resolveResumeTarget,
  WAIT_TIMEOUT_EXIT_CODE
} from "./lib/job-control.mjs";
import {
  escapeUntrustedPromptData,
  interpolateTemplate,
  loadPromptTemplate
} from "./lib/prompts.mjs";
import { getProcessIdentity, spawnDetachedProcess } from "./lib/process.mjs";
import {
  renderCancelReport,
  renderCleanupReport,
  renderExportReport,
  renderJobStatusReport,
  renderLogsReport,
  renderQueuedLaunch,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  validateReviewResult
} from "./lib/render.mjs";
import {
  generateJobId,
  resolveJobFile,
  resolveStateDir,
  resolveStateRootInfo,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  indexJobRecord,
  publishDetachedWorkerPid,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REVIEW_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(SCRIPT_DIR, "../schemas/review-output.schema.json"), "utf8")
);
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;
/** Default continue prompt when resuming without an explicit instruction. */
export const DEFAULT_CONTINUE_PROMPT = "Continue from where you left off. Pick up the unfinished work and complete it.";
/** Hard cap for task prompts from args, stdin, or --prompt-file (bytes, UTF-8). */
export const MAX_PROMPT_BYTES = 16 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  grok-companion.mjs setup [--json]",
    "  grok-companion.mjs review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]",
    "                     [--model <id>] [--timeout-ms <ms>] [--inline-diff-max-files N]",
    "                     [--inline-diff-max-bytes N] [--json]",
    "  grok-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]",
    "                     [--model <id>] [--timeout-ms <ms>] [--inline-diff-max-files N]",
    "                     [--inline-diff-max-bytes N] [--focus-file <path>] [--json] [focus...]",
    "  grok-companion.mjs task [--background] [--write|--read-only] [--fresh]",
    "                     [--session-id <id>] [--resume-job <job-id>] [--model <id>] [--effort <level>]",
    "                     [--timeout-ms <ms>] [--prompt-file <path>|--stdin] [--json] [prompt]",
    "  grok-companion.mjs status [job-id] [--all] [--kind <kind>] [--status <status>] [--limit N]",
    "                     [--progress-lines N] [--logs [N]] [--wait] [--with-result] [--timeout-ms <ms>]",
    "                     [--poll-interval-ms <ms>] [--json]",
    "  grok-companion.mjs result [job-id] [--wait] [--out <path>] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    "  grok-companion.mjs cancel [job-id] [--all] [--kind <kind>] [--json]",
    "  grok-companion.mjs cleanup [--older-than <duration>] [--keep N] [--dry-run] [--json]"
  ].join("\n");
}

function commandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
}

function commandCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function output(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

function shorten(value, limit = 120) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function normalizeEffort(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const effort = String(value).toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  return effort;
}

function requireAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Grok CLI is unavailable (${availability.detail}). Run $grok-setup.`);
  }
}

function makeJob({ cwd, kind, title, summary, write, request, sessionId = null, sessionConfirmed = false }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = createJobRecord({
    id: generateJobId(kind === "adversarial-review" ? "review" : kind),
    kind,
    title,
    status: "created",
    phase: "created",
    pid: null,
    cwd,
    workspaceRoot,
    summary,
    promptSummary: summary,
    write: Boolean(write),
    sessionId,
    sessionConfirmed,
    resumable: false,
    request
  });
  return job;
}

function formatByteCount(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
  }
  return `${bytes} bytes`;
}

function assertPromptWithinLimit(prompt, source, maxBytes = MAX_PROMPT_BYTES) {
  const bytes = Buffer.byteLength(prompt ?? "", "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `Prompt from ${source} is ${formatByteCount(bytes)} (${bytes} bytes), `
      + `which exceeds the maximum of ${formatByteCount(maxBytes)} (${maxBytes} bytes).`
    );
  }
  return prompt;
}

function readPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    const filePath = path.resolve(cwd, options["prompt-file"]);
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read --prompt-file "${filePath}": ${detail}`);
    }
    if (size > MAX_PROMPT_BYTES) {
      throw new Error(
        `--prompt-file "${filePath}" is ${formatByteCount(size)} (${size} bytes), `
        + `which exceeds the maximum of ${formatByteCount(MAX_PROMPT_BYTES)} (${MAX_PROMPT_BYTES} bytes).`
      );
    }
    return assertPromptWithinLimit(fs.readFileSync(filePath, "utf8"), `--prompt-file ${filePath}`);
  }
  const fromArgs = positionals.join(" ").trim();
  if (fromArgs) {
    return assertPromptWithinLimit(fromArgs, "command-line arguments");
  }
  if (options.stdin) {
    const fromStdin = readStdinIfPiped();
    assertPromptWithinLimit(fromStdin, "stdin");
    return fromStdin.trim();
  }
  return "";
}

async function buildSetup(cwd) {
  const grok = getGrokAvailability(cwd);
  const capabilities = grok.available
    ? getGrokCapabilities(cwd)
    : { available: false, jsonSchema: false, sandbox: false, detail: "Grok CLI is unavailable." };
  const auth = getGrokAuthStatus(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateRoot = resolveStateRootInfo();
  const nextSteps = [];
  if (!grok.available) {
    nextSteps.push("Install the Grok CLI and ensure `grok` is on PATH.");
  } else if (!capabilities.available) {
    nextSteps.push("Upgrade the Grok CLI to a version that supports `--json-schema` and `--sandbox`.");
  } else if (auth.status === "needs_login") {
    nextSteps.push("Run `grok login`.");
  } else if (auth.status === "unknown") {
    nextSteps.push("Authentication was not probed to avoid a network/model call; run `grok login` if the first task reports an auth error.");
  }
  return {
    ready: grok.available && capabilities.available && isGrokAuthReady(auth),
    node: { available: true, detail: process.version },
    grok,
    capabilities,
    auth,
    stateDir: resolveStateDir(workspaceRoot),
    stateSource: stateRoot.source,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = commandCwd(options);
  const report = await buildSetup(cwd);
  output(report, renderSetupReport(report), options.json);
}

function buildReviewRequest(cwd, options, focus, adversarial) {
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target, {
    maxInlineFiles: options["inline-diff-max-files"] == null
      ? undefined
      : parsePositiveInt(options["inline-diff-max-files"], "--inline-diff-max-files"),
    maxInlineDiffBytes: options["inline-diff-max-bytes"] == null
      ? undefined
      : parsePositiveInt(options["inline-diff-max-bytes"], "--inline-diff-max-bytes")
  });
  if (context.fileCount === 0) {
    throw new Error(`Nothing to review for ${target.label}.`);
  }
  if (!adversarial && focus) {
    throw new Error("The review command does not accept focus text. Use adversarial-review.");
  }
  const prompt = interpolateTemplate(
    loadPromptTemplate(ROOT_DIR, adversarial ? "adversarial-review" : "review"),
    {
      TARGET_LABEL: target.label,
      USER_FOCUS: escapeUntrustedPromptData(focus || "(none)", "untrusted_user_focus"),
      CHANGE_SUMMARY: context.summary,
      COLLECTION_GUIDANCE: context.collectionGuidance,
      REPOSITORY_CONTEXT: escapeUntrustedPromptData(
        context.content,
        "untrusted_repository_context"
      )
    }
  );
  const timeoutMs = parseTimeoutMs(options["timeout-ms"], { allowNull: true });
  return {
    type: "review",
    cwd: context.repoRoot,
    prompt,
    adversarial,
    target,
    context: {
      summary: context.summary,
      fileCount: context.fileCount,
      diffBytes: context.diffBytes,
      truncated: context.truncated === true,
      inputMode: context.inputMode,
      collectionGuidance: context.collectionGuidance
    },
    model: options.model ?? null,
    timeoutMs
  };
}

function parseTimeoutMs(value, { allowNull = false } = {}) {
  if (value == null || value === "") {
    if (allowNull) {
      return null;
    }
    throw new Error("--timeout-ms must be a positive number.");
  }
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return timeoutMs;
}

function parsePositiveInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return parsed;
}

async function executeReview(request, onProgress) {
  if (request.context.truncated === true) {
    const parseError = "Review context was truncated; refusing to invoke Grok on an incomplete diff. Narrow the review with --base or --scope.";
    const payload = {
      exitCode: 1,
      sessionId: null,
      result: null,
      rawOutput: "",
      parseError,
      stderr: "",
      target: request.target,
      context: request.context
    };
    return {
      exitCode: 1,
      sessionId: null,
      payload,
      rendered: renderReviewResult(payload),
      errorMessage: parseError
    };
  }
  const result = await runGrokHeadless({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    write: false,
    sandbox: "read-only",
    jsonSchema: REVIEW_SCHEMA,
    onProgress,
    timeoutMs: request.timeoutMs
  });
  const parsed = parseGrokStructuredOutput(result.stdout);
  const validationError = parsed.ok ? validateReviewResult(parsed.data) : null;
  const stopReasonError = result.exitCode === 0 ? grokStopReasonError(parsed.stopReason) : null;
  const parseError = stopReasonError || (parsed.ok
    ? (validationError ? `Structured review validation failed: ${validationError}` : null)
    : parsed.parseError);
  const exitCode = result.exitCode === 0 && parseError ? 1 : result.exitCode;
  const payload = {
    exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    stopReason: parsed.stopReason ?? null,
    result: parsed.ok ? parsed.data : null,
    rawOutput: result.stdout.trimEnd(),
    parseError,
    stderr: result.stderr.trimEnd(),
    signal: result.signal,
    durationMs: result.durationMs,
    target: request.target,
    context: request.context
  };
  return {
    exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    payload,
    rendered: renderReviewResult(payload),
    errorMessage: exitCode === 0
      ? null
      : (parseError || result.stderr.trim() || `Grok exited with ${result.exitCode}.`)
  };
}

async function executeTask(request, onProgress, onTelemetry) {
  const result = await runGrokHeadless({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    effort: request.effort,
    write: request.write,
    sessionId: request.sessionId,
    sessionConfirmed: request.sessionConfirmed,
    resumeSessionId: request.resumeSessionId,
    outputFormat: "streaming-json",
    onProgress,
    onTelemetry,
    timeoutMs: request.timeoutMs
  });
  const stopReasonError = result.exitCode === 0 ? grokStopReasonError(result.stopReason) : null;
  const exitCode = result.exitCode === 0 && stopReasonError ? 1 : result.exitCode;
  const payload = {
    exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    stopReason: result.stopReason,
    rawOutput: result.stdout.trimEnd(),
    rawStreamingOutput: result.rawStdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
    signal: result.signal,
    durationMs: result.durationMs,
    write: request.write,
    resumed: Boolean(request.resumeSessionId)
  };
  return {
    exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    payload,
    rendered: renderTaskResult(payload, { title: request.title }),
    errorMessage: exitCode === 0
      ? null
      : (stopReasonError || result.stderr.trim() || `Grok exited with ${result.exitCode}.`)
  };
}

function executeRequest(request, onProgress, onTelemetry) {
  if (request.type === "review") {
    return executeReview(request, onProgress);
  }
  if (request.type === "task") {
    return executeTask(request, onProgress, onTelemetry);
  }
  throw new Error(`Unknown stored job request type: ${request.type}`);
}

async function runForeground(job, json) {
  const logPath = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({ stderr: !json, logPath });
  const telemetry = createJobProgressUpdater({ workspaceRoot: job.workspaceRoot, jobId: job.id, logPath });
  const execution = await runTrackedJob(
    { ...job, logPath, resultPath: resolveJobFile(job.workspaceRoot, job.id) },
    () => executeRequest(job.request, progress, telemetry),
    { logPath }
  );
  output(execution.payload, execution.rendered, json);
  if (execution.exitCode !== 0) {
    process.exitCode = execution.exitCode;
  }
}

function spawnWorker(cwd, jobId) {
  return spawnDetachedProcess(
    process.execPath,
    [path.join(SCRIPT_DIR, "grok-companion.mjs"), "job-worker", "--cwd", cwd, "--job-id", jobId],
    {
      cwd,
      env: {
        ...process.env,
        GROK_COMPANION_BACKGROUND_WORKER: "1"
      }
    }
  );
}

function persistWorkerLaunchFailure(job, error) {
  const message = error instanceof Error ? error.message : String(error);
  const stored = readStoredJob(job.workspaceRoot, job.id) ?? job;
  const { request: _request, ...base } = stored;
  const failed = {
    ...base,
    status: "failed",
    phase: "spawn-failed",
    pid: null,
    completedAt: new Date().toISOString(),
    resumable: false,
    errorMessage: `Failed to start background worker: ${message}`
  };
  writeJobFile(job.workspaceRoot, job.id, failed);
  upsertJob(job.workspaceRoot, indexJobRecord(failed));
  appendLogLine(failed.logPath, `Failed: ${failed.errorMessage}`);
  return failed;
}

async function enqueue(job) {
  const logPath = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const queued = {
    ...job,
    status: "queued",
    phase: "queued",
    workerLaunchStartedAt: new Date().toISOString(),
    logPath,
    resultPath: resolveJobFile(job.workspaceRoot, job.id)
  };
  writeJobFile(job.workspaceRoot, job.id, queued);
  upsertJob(job.workspaceRoot, indexJobRecord(queued));
  appendLogLine(logPath, "Queued for background execution.");
  let child;
  try {
    child = await spawnWorker(job.cwd, job.id);
  } catch (error) {
    const failed = persistWorkerLaunchFailure(job, error);
    throw new Error(failed.errorMessage);
  }
  const identity = getProcessIdentity(child.pid, {
    cwd: job.cwd,
    env: process.env
  });
  publishDetachedWorkerPid(job.workspaceRoot, job.id, child.pid, identity);
  return {
    jobId: job.id,
    status: "queued",
    title: job.title,
    summary: job.summary,
    logPath
  };
}

async function handleReview(argv, adversarial) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: [
      "base",
      "scope",
      "model",
      "cwd",
      "timeout-ms",
      "focus-file",
      "inline-diff-max-files",
      "inline-diff-max-bytes"
    ],
    booleanOptions: ["json", "background", "wait"]
  });
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
  const cwd = commandCwd(options);
  requireAvailable(cwd);
  if (options["focus-file"] && positionals.length) {
    throw new Error("Choose either --focus-file or positional focus text.");
  }
  const focus = options["focus-file"]
    ? readPrompt(cwd, { "prompt-file": options["focus-file"] }, [])
    : positionals.join(" ").trim();
  const request = buildReviewRequest(cwd, options, focus, adversarial);
  const kind = adversarial ? "adversarial-review" : "review";
  const title = adversarial ? "Grok Adversarial Review" : "Grok Review";
  const job = makeJob({
    cwd: request.cwd,
    kind,
    title,
    summary: `${title} for ${request.target.label}`,
    write: false,
    request
  });
  if (options.background) {
    const payload = await enqueue(job);
    output(payload, renderQueuedLaunch(payload), options.json);
  } else {
    await runForeground(job, options.json);
  }
}

async function handleTask(argv) {
  const normalized = normalizeArgv(argv);
  if (normalized.some((token) => /^--resume(?:=|$)|^--resume-last(?:=|$)/.test(token))) {
    throw new Error("Implicit resume was removed; pass --resume-job <job-id> or --session-id <id> explicitly.");
  }
  const { options, positionals } = commandInput(normalized, {
    valueOptions: ["cwd", "prompt-file", "model", "effort", "timeout-ms", "session-id", "resume-job"],
    booleanOptions: [
      "json",
      "background",
      "write",
      "read-only",
      "fresh",
      "stdin"
    ]
  });
  if (options.write && options["read-only"]) {
    throw new Error("Choose either --write or --read-only.");
  }
  const wantsResume = Boolean(
    options["session-id"]
    || options["resume-job"]
  );
  if (wantsResume && options.fresh) {
    throw new Error("Choose either an explicit resume option (--session-id/--resume-job) or --fresh.");
  }
  const cwd = commandCwd(options);
  requireAvailable(cwd);
  // Reclaim dead-PID jobs before explicit resume lookup or enqueue.
  reconcileSessionJobs(resolveWorkspaceRoot(cwd));
  let prompt = readPrompt(cwd, options, positionals);
  if (!prompt) {
    if (wantsResume) {
      prompt = DEFAULT_CONTINUE_PROMPT;
    } else {
      throw new Error("Provide a task prompt, --prompt-file, or --stdin.");
    }
  }

  let resume = null;
  if (options["session-id"] || options["resume-job"]) {
    resume = resolveResumeTarget(cwd, {
      sessionId: options["session-id"] ?? null,
      resumeJob: options["resume-job"] ?? null
    });
  }

  const write = options.write === true;
  const timeoutMs = parseTimeoutMs(options["timeout-ms"], { allowNull: true });
  const kind = "task";
  const title = resume ? "Grok Resumed Task" : "Grok Task";
  const sessionId = resume?.sessionId ?? randomUUID();
  const request = {
    type: "task",
    cwd: resolveWorkspaceRoot(cwd),
    prompt,
    write,
    model: options.model ?? null,
    effort: normalizeEffort(options.effort),
    sessionId,
    sessionConfirmed: Boolean(resume?.sessionConfirmed),
    resumeSessionId: resume?.sessionId ?? null,
    timeoutMs,
    title
  };
  const job = makeJob({
    cwd: request.cwd,
    kind,
    title,
    summary: shorten(prompt),
    write,
    request,
    sessionId,
    sessionConfirmed: Boolean(resume?.sessionConfirmed)
  });
  if (options.background) {
    const payload = await enqueue(job);
    output(payload, renderQueuedLaunch(payload), options.json);
  } else {
    await runForeground(job, options.json);
  }
}

async function waitForJob(cwd, reference, timeoutMs, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const enrichOptions = { maxProgressLines: options.maxProgressLines };
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference, enrichOptions);
  while (["queued", "running"].includes(snapshot.job.status) && Date.now() < deadline) {
    const remainingMs = Math.max(0, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    snapshot = buildSingleJobSnapshot(cwd, reference, enrichOptions);
  }
  return {
    ...snapshot,
    waitedJobId: snapshot.job.id,
    waitTimedOut: ["queued", "running"].includes(snapshot.job.status),
    timeoutMs
  };
}

function expandOptionalLogsFlag(argv, defaultTail = DEFAULT_LOG_TAIL_LINES) {
  const expanded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--logs") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-") || !/^\d+$/.test(next)) {
        expanded.push("--logs", String(defaultTail));
      } else {
        expanded.push("--logs", next);
        index += 1;
      }
      continue;
    }
    expanded.push(token);
  }
  return expanded;
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(expandOptionalLogsFlag(normalizeArgv(argv)), {
    valueOptions: [
      "cwd",
      "timeout-ms",
      "kind",
      "status",
      "limit",
      "progress-lines",
      "logs",
      "poll-interval-ms"
    ],
    booleanOptions: ["json", "all", "wait", "with-result"],
    aliasMap: { C: "cwd" }
  });
  const cwd = commandCwd(options);
  const reference = positionals[0] ?? "";
  if (positionals.length > 1) {
    throw new Error("`status` accepts at most one job id; `--logs` accepts an optional non-negative line count.");
  }
  const timeoutMs = options["timeout-ms"] == null
    ? DEFAULT_STATUS_WAIT_TIMEOUT_MS
    : parseNonNegativeInt(options["timeout-ms"], "--timeout-ms");
  const pollIntervalMs = options["poll-interval-ms"] == null
    ? DEFAULT_STATUS_POLL_INTERVAL_MS
    : parsePositiveInt(options["poll-interval-ms"], "--poll-interval-ms");
  const maxProgressLines = options["progress-lines"] == null
    ? undefined
    : parseNonNegativeInt(options["progress-lines"], "--progress-lines");
  const maxJobs = options.limit == null
    ? undefined
    : parsePositiveInt(options.limit, "--limit");

  if (options.logs != null) {
    if (options.wait || options["with-result"]) {
      throw new Error("`status --logs` cannot be combined with --wait or --with-result.");
    }
    if (options.all || options.kind != null || options.status != null || options.limit != null || options["progress-lines"] != null) {
      throw new Error("`status --logs` cannot be combined with list filters or --progress-lines.");
    }
    const tail = parseNonNegativeInt(options.logs, "--logs");
    const payload = readJobLogs(cwd, reference, { tail });
    output(payload, renderLogsReport(payload), options.json);
    return;
  }

  if (options.wait && !reference) {
    throw new Error("`status --wait` requires a job id.");
  }
  if (options["with-result"] && !options.wait) {
    throw new Error("`--with-result` requires `--wait`.");
  }
  if (options["with-result"] && !reference) {
    throw new Error("`status --wait --with-result` requires a job id.");
  }

  if (reference) {
    const snapshot = options.wait
      ? await waitForJob(cwd, reference, timeoutMs, { pollIntervalMs, maxProgressLines })
      : buildSingleJobSnapshot(cwd, reference, { maxProgressLines });

    if (options.wait && options["with-result"] && !snapshot.waitTimedOut) {
      const stored = readStoredJob(snapshot.workspaceRoot, snapshot.job.id) ?? snapshot.job;
      const payload = {
        ...snapshot,
        result: stored
      };
      output(payload, renderStoredJobResult(stored), options.json);
      if (stored.status === "failed" || (stored.exitCode != null && stored.exitCode !== 0)) {
        process.exitCode = stored.exitCode && stored.exitCode !== 0 ? stored.exitCode : 1;
      }
      return;
    }

    output(snapshot, renderJobStatusReport(snapshot.job), options.json);
    if (snapshot.waitTimedOut) {
      process.exitCode = WAIT_TIMEOUT_EXIT_CODE;
    }
    return;
  }

  const snapshot = buildStatusSnapshot(cwd, {
    all: options.all,
    kind: options.kind ?? null,
    status: options.status ?? null,
    maxJobs,
    maxProgressLines
  });
  output(snapshot, renderStatusReport(snapshot), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "out"],
    booleanOptions: ["json", "wait"]
  });
  const cwd = commandCwd(options);
  const reference = positionals[0] ?? "";
  if (options.out != null) {
    if (options.wait) {
      throw new Error("`result --out` cannot be combined with --wait.");
    }
    if (!reference) {
      throw new Error("`result --out` requires a job id.");
    }
    const payload = exportJobBundle(cwd, reference, { out: options.out });
    output(payload, renderExportReport(payload), options.json);
    return;
  }
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const timeoutMs = options["timeout-ms"] == null
      ? DEFAULT_STATUS_WAIT_TIMEOUT_MS
      : parseNonNegativeInt(options["timeout-ms"], "--timeout-ms");
    const pollIntervalMs = options["poll-interval-ms"] == null
      ? DEFAULT_STATUS_POLL_INTERVAL_MS
      : parsePositiveInt(options["poll-interval-ms"], "--poll-interval-ms");
    const snapshot = await waitForJob(cwd, reference, timeoutMs, { pollIntervalMs });
    if (snapshot.waitTimedOut) {
      output(snapshot, renderJobStatusReport(snapshot.job), options.json);
      process.exitCode = WAIT_TIMEOUT_EXIT_CODE;
      return;
    }
    const stored = readStoredJob(snapshot.workspaceRoot, snapshot.job.id) ?? snapshot.job;
    output(stored, renderStoredJobResult(stored), options.json);
    if (stored.status === "failed" || (stored.exitCode != null && stored.exitCode !== 0 && stored.status !== "cancelled")) {
      process.exitCode = stored.exitCode && stored.exitCode !== 0 ? stored.exitCode : 1;
    }
    return;
  }

  const { workspaceRoot, job } = resolveResultJob(cwd, reference, { env: process.env });
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  output(stored, renderStoredJobResult(stored), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "kind"],
    booleanOptions: ["json", "all"]
  });
  const cwd = commandCwd(options);
  const reference = positionals[0] ?? "";
  if (options.all) {
    if (reference) {
      throw new Error("Pass either a job id or --all, not both.");
    }
    const { workspaceRoot, jobs } = resolveCancelableJobs(cwd, {
      all: true,
      kind: options.kind ?? null,
      env: process.env
    });
    if (jobs.length === 0) {
      throw new Error(options.kind
        ? `No active Grok jobs of kind "${options.kind}" to cancel.`
        : "No active Grok jobs to cancel.");
    }
    const results = await cancelTrackedJobsParallel(workspaceRoot, jobs, {
      env: process.env,
      reason: "cancel --all"
    });
    const payload = {
      requestedCount: jobs.length,
      cancelledCount: results.filter((entry) => entry.status === "cancelled").length,
      results: results.map((entry, index) => ({
        jobId: jobs[index].id,
        previousStatus: entry.previousStatus,
        status: entry.status,
        delivered: entry.delivered,
        method: entry.method,
        errorMessage: entry.errorMessage
      }))
    };
    output(payload, renderCancelReport(payload), options.json);
    if (payload.cancelledCount !== payload.requestedCount) {
      process.exitCode = 1;
    }
    return;
  }

  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, {
    env: process.env,
    kind: options.kind ?? null
  });
  const cancellation = cancelTrackedJob(workspaceRoot, job, { env: process.env });
  const payload = {
    jobId: job.id,
    previousStatus: cancellation.previousStatus,
    status: cancellation.status,
    delivered: cancellation.delivered,
    method: cancellation.method,
    errorMessage: cancellation.errorMessage
  };
  output(payload, renderCancelReport(payload), options.json);
  if (cancellation.status !== "cancelled") {
    process.exitCode = 1;
  }
}

function handleCleanup(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd", "older-than", "keep"],
    booleanOptions: ["json", "dry-run"]
  });
  const cwd = commandCwd(options);
  if (options["older-than"] == null && options.keep == null) {
    throw new Error("Pass --older-than <duration> and/or --keep <N> to select jobs for cleanup.");
  }
  const keep = options.keep == null ? null : parseNonNegativeInt(options.keep, "--keep");
  const payload = cleanupJobs(cwd, {
    olderThan: options["older-than"] ?? null,
    keep,
    dryRun: Boolean(options["dry-run"])
  });
  output(payload, renderCleanupReport(payload), options.json);
}

async function handleWorker(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("job-worker requires --job-id.");
  }
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readStoredJob(workspaceRoot, options["job-id"]);
  if (!job?.request) {
    throw new Error(`Stored job ${options["job-id"]} has no request payload.`);
  }
  // A queued job may be observed before or after the launcher publishes this
  // worker's PID. Never let a foreign worker execute or finalize it.
  const runnable = (
    job.status === "queued"
    && (!job.pid || job.pid === process.pid)
  ) || (
    job.status === "running"
    && job.pid === process.pid
  );
  if (
    runnable
    && (
      job.cancelRequestedAt
      || job.phase === "cancel-requested"
      || job.phase === "cancel-failed"
    )
  ) {
    finalizeCancelledJob(workspaceRoot, job, {
      terminationMethod: "cancelled-before-start",
      logMessage: "Cancelled before the background worker began executing Grok."
    });
    return;
  }
  // Only queued jobs (or a running job already owned by this process) may execute.
  // Reject completed/cancelled/failed/foreign-running re-entry so results are not overwritten.
  if (!runnable) {
    const reason = `job-worker refused to run job ${job.id}: status is "${job.status}"`
      + (job.pid != null ? ` (pid ${job.pid})` : "")
      + "; only queued jobs (or running with this process pid) may execute.";
    if (job.logPath) {
      try {
        appendLogLine(job.logPath, reason);
      } catch {
        // Best-effort; still fail closed below.
      }
    }
    throw new Error(reason);
  }
  const progress = createProgressReporter({ logPath: job.logPath });
  const telemetry = createJobProgressUpdater({ workspaceRoot, jobId: job.id, logPath: job.logPath });
  await runTrackedJob(
    { ...job, workspaceRoot },
    () => executeRequest(job.request, progress, telemetry),
    { logPath: job.logPath }
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv, false);
      break;
    case "adversarial-review":
      await handleReview(argv, true);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "cleanup":
      handleCleanup(argv);
      break;
    case "job-worker":
      await handleWorker(argv);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${usage()}\n`);
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
