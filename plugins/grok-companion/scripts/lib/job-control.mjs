import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  isProcessAlive,
  PROCESS_START_TIME_SKEW_MS,
  terminateProcessTree
} from "./process.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateState,
  upsertJob,
  writeJobFile
} from "./state.mjs";
import { appendLogLine, indexJobRecord, nowIso } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_PROGRESS_PREVIEW_LINES = 4;
/** Default budget for coordinated multi-job cancellation. */
export const DEFAULT_CANCEL_BUDGET_MS = 55_000;
/** Only the trailing slice of job logs is scanned for status progress previews. */
export const PROGRESS_PREVIEW_TAIL_BYTES = 64 * 1024;
/** Default log lines returned by the logs command. */
export const DEFAULT_LOG_TAIL_LINES = 80;
/** Exit code when status/result --wait times out while the job is still active. */
export const WAIT_TIMEOUT_EXIT_CODE = 124;
export const PIDLESS_QUEUE_GRACE_MS = 15_000;
/** Bounded backoff while a detached worker publishes its PID or finishes starting. */
export const CANCEL_TERMINATE_RETRY_DELAYS_MS = [25, 50, 100, 200];

const cancelRetryWaiter = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(cancelRetryWaiter, 0, 0, milliseconds);
  }
}

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function duration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  const end = endValue ? Date.parse(endValue) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? formatDuration(end - start)
    : null;
}

function readLogTail(logPath, maxBytes = PROGRESS_PREVIEW_TAIL_BYTES) {
  const fd = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) {
      return "";
    }
    const readSize = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, size - readSize);
    let text = buffer.toString("utf8");
    // Drop a leading partial line when the file was larger than the tail window.
    if (size > readSize) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function progressPreview(logPath, maxLines = DEFAULT_PROGRESS_PREVIEW_LINES) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }
  let text;
  try {
    text = readLogTail(logPath);
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => /^\[[^\]]+\]/.test(line))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .slice(-maxLines);
}

export function enrichJob(job, options = {}) {
  const active = job.status === "queued" || job.status === "running";
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_PROGRESS_PREVIEW_LINES;
  return {
    ...job,
    phase: job.phase ?? job.status ?? "unknown",
    elapsed: active ? duration(job.startedAt ?? job.createdAt) : null,
    duration: active
      ? null
      : (formatDuration(job.durationMs) ?? duration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)),
    progressPreview: active || job.status === "failed" ? progressPreview(job.logPath, maxProgressLines) : []
  };
}

function persistJob(workspaceRoot, job) {
  writeJobFile(workspaceRoot, job.id, job);
  const persisted = readStoredJob(workspaceRoot, job.id) ?? job;
  upsertJob(workspaceRoot, indexJobRecord(persisted));
  return persisted;
}

function identityOptions(job, options = {}) {
  return {
    cwd: job.cwd,
    env: options.env,
    platform: options.platform,
    runCommandImpl: options.runCommandImpl,
    killImpl: options.killImpl,
    getIdentityImpl: options.getIdentityImpl,
    expectedName: job.processName ?? null,
    expectedStartedAtMs: job.processStartedAtMs ?? null,
    identityCacheMs: options.identityCacheMs,
    startTimeSkewMs: options.startTimeSkewMs ?? PROCESS_START_TIME_SKEW_MS
  };
}

export function reconcileOrphanedJob(workspaceRoot, job, options = {}) {
  if (!["queued", "running"].includes(job.status)) {
    return job;
  }
  if (!job.pid) {
    const launchAt = Date.parse(job.workerLaunchStartedAt ?? "");
    const nowMs = options.nowMs?.() ?? Date.now();
    const graceMs = options.pidlessQueueGraceMs ?? PIDLESS_QUEUE_GRACE_MS;
    if (job.status !== "queued" || !Number.isFinite(launchAt) || nowMs - launchAt <= graceMs) {
      return job;
    }
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    if (!["queued", "running"].includes(stored.status) || stored.pid) {
      return stored;
    }
    const message = "Background worker did not publish a process ID before the launch grace period expired.";
    const { request: _request, ...base } = stored;
    const failed = persistJob(workspaceRoot, {
      ...base,
      status: "failed",
      phase: "spawn-missing",
      pid: null,
      completedAt: nowIso(),
      resumable: false,
      errorMessage: message
    });
    appendLogLine(failed.logPath, `Failed: ${message}`);
    return failed;
  }
  const alive = options.isProcessAliveImpl ?? isProcessAlive;
  if (alive(job.pid, identityOptions(job, options))) {
    return job;
  }
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  if (
    !["queued", "running"].includes(stored.status)
    || (stored.pid && alive(stored.pid, identityOptions(stored, options)))
  ) {
    return stored;
  }
  const message = `Tracked Grok process ${job.pid} exited before the job reached a terminal state.`;
  const { request: _request, ...base } = stored;
  const cancelWasRequested = Boolean(
    stored.cancelRequestedAt
    || stored.phase === "cancel-requested"
    || stored.phase === "cancel-failed"
  );
  if (cancelWasRequested) {
    const cancelledAt = nowIso();
    const cancelled = persistJob(workspaceRoot, {
      ...base,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: cancelledAt,
      cancelledAt: stored.cancelledAt ?? cancelledAt,
      cancelRequestedAt: stored.cancelRequestedAt ?? cancelledAt,
      terminationMethod: stored.terminationMethod ?? "already-exited",
      terminationDelivered: stored.terminationDelivered === true,
      resumable: stored.kind === "task" && Boolean(stored.sessionConfirmed),
      errorMessage: null
    });
    if (cancelled.status === "cancelled") {
      appendLogLine(cancelled.logPath, `Cancelled after reconcile: tracked process ${job.pid} exited following a cancel request.`);
    }
    return cancelled;
  }
  const failed = persistJob(workspaceRoot, {
    ...base,
    status: "failed",
    phase: "process-exited",
    pid: null,
    completedAt: nowIso(),
    resumable: stored.kind === "task" && Boolean(stored.sessionConfirmed),
    errorMessage: message
  });
  appendLogLine(failed.logPath, `Failed: ${message}`);
  return failed;
}

/**
 * Reconcile every indexed job (orphan PID → failed). Used by status/result paths.
 */
export function reconcileJobs(workspaceRoot, options = {}) {
  return listJobs(workspaceRoot).map((job) => reconcileOrphanedJob(workspaceRoot, job, options));
}

/**
 * Reconcile jobs for the current workspace.
 *
 * Wire this at companion entry points that must not see stale "running" orphans:
 * - task (before explicit resume lookup / enqueue)
 *
 * status/result already reconcile via buildStatusSnapshot / resolveResultJob.
 */
export function reconcileSessionJobs(workspaceRoot, options = {}) {
  return listJobs(workspaceRoot).map((job) => reconcileOrphanedJob(workspaceRoot, job, options));
}

function reconciledJobs(workspaceRoot, options = {}) {
  return reconcileJobs(workspaceRoot, options);
}

/**
 * Persist cancel-requested without waiting for process termination.
 * Used when coordinated cancellation is about to time out so status can reclaim the job.
 */
export function markJobCancelRequested(workspaceRoot, job, options = {}) {
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  if (!["queued", "running"].includes(stored.status) && stored.phase !== "cancel-requested") {
    return stored;
  }
  if (stored.phase === "cancel-requested" && stored.cancelRequestedAt) {
    return stored;
  }
  const cancelRequestedAt = nowIso();
  const requested = persistJob(workspaceRoot, {
    ...stored,
    phase: "cancel-requested",
    cancelRequestedAt,
    terminationDelivered: null,
    terminationMethod: null,
    errorMessage: null
  });
  appendLogLine(requested.logPath, `Cancellation requested${options.reason ? `: ${options.reason}` : "."}`);
  return requested;
}

export function cancelTrackedJob(workspaceRoot, job, options = {}) {
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  const requested = options.alreadyMarked
    ? (readStoredJob(workspaceRoot, job.id) ?? stored)
    : markJobCancelRequested(workspaceRoot, job, options);
  if (!["queued", "running"].includes(requested.status) && requested.phase !== "cancel-requested" && requested.phase !== "cancel-failed") {
    return {
      job: requested,
      previousStatus: stored.status,
      status: requested.status,
      delivered: false,
      method: null,
      errorMessage: null
    };
  }

  const alive = options.isProcessAliveImpl ?? isProcessAlive;
  const terminate = options.terminateImpl ?? terminateProcessTree;
  const sleep = options.sleepImpl ?? sleepSyncMs;
  const retryDelays = options.retryDelaysMs ?? CANCEL_TERMINATE_RETRY_DELAYS_MS;
  const maxAttempts = Math.max(1, retryDelays.length + 1);

  let termination = { attempted: false, delivered: false, method: null };
  let terminationError = null;
  let lastPid = isValidPid(requested.pid) ? requested.pid : null;
  let sawAlive = false;
  let confirmedExit = false;
  let latestSnapshot = requested;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    latestSnapshot = readStoredJob(workspaceRoot, job.id) ?? latestSnapshot;
    if (latestSnapshot.status === "cancelled") {
      return {
        job: latestSnapshot,
        previousStatus: stored.status,
        status: "cancelled",
        delivered: Boolean(latestSnapshot.terminationDelivered),
        method: latestSnapshot.terminationMethod ?? null,
        errorMessage: null
      };
    }
    if (isValidPid(latestSnapshot.pid)) {
      lastPid = latestSnapshot.pid;
    }

    if (!isValidPid(lastPid)) {
      if (attempt < maxAttempts - 1) {
        sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 25);
      }
      continue;
    }

    const guard = identityOptions(latestSnapshot, options);
    const currentlyAlive = alive(lastPid, guard);
    if (currentlyAlive) {
      sawAlive = true;
    } else if (sawAlive) {
      confirmedExit = true;
      break;
    }

    try {
      const result = terminate(lastPid, {
        cwd: latestSnapshot.cwd ?? requested.cwd,
        env: options.env,
        ...guard
      });
      termination = {
        attempted: true,
        delivered: Boolean(result?.delivered),
        method: result?.method ?? null
      };
    } catch (error) {
      terminationError = error instanceof Error ? error.message : String(error);
      termination = { attempted: true, delivered: false, method: termination.method ?? null };
    }

    if (termination.delivered) {
      break;
    }

    if (!alive(lastPid, guard)) {
      if (sawAlive) {
        confirmedExit = true;
        break;
      }
    } else {
      sawAlive = true;
    }

    if (attempt < maxAttempts - 1) {
      sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 25);
    }
  }

  if (termination.delivered || confirmedExit) {
    const cancelledAt = nowIso();
    const method = termination.method ?? (confirmedExit ? "already-exited" : null);
    const { request: _request, ...base } = latestSnapshot;
    const final = persistJob(workspaceRoot, {
      ...base,
      status: "cancelled",
      phase: options.cancelledPhase ?? "cancelled",
      pid: null,
      completedAt: cancelledAt,
      cancelledAt,
      cancelRequestedAt: latestSnapshot.cancelRequestedAt ?? requested.cancelRequestedAt ?? cancelledAt,
      terminationMethod: method,
      terminationDelivered: Boolean(termination.delivered),
      resumable: latestSnapshot.kind === "task" && Boolean(latestSnapshot.sessionConfirmed),
      errorMessage: null
    });
    if (final.status !== "cancelled") {
      return {
        job: final,
        previousStatus: stored.status,
        status: final.status,
        delivered: Boolean(termination.delivered),
        method: termination.method ?? null,
        errorMessage: final.errorMessage ?? null
      };
    }
    appendLogLine(final.logPath, `Cancelled via ${method ?? "confirmed process exit"}; signal delivered: ${Boolean(termination.delivered)}.`);
    return { job: final, previousStatus: stored.status, status: "cancelled", delivered: Boolean(termination.delivered), method, errorMessage: null };
  }

  latestSnapshot = readStoredJob(workspaceRoot, job.id) ?? latestSnapshot;
  if (isValidPid(latestSnapshot.pid)) {
    lastPid = latestSnapshot.pid;
  }

  if (!isValidPid(lastPid)) {
    const pendingMessage = "Worker PID not available yet; left cancel-requested for later reclaim.";
    const pending = persistJob(workspaceRoot, {
      ...latestSnapshot,
      phase: "cancel-requested",
      terminationMethod: null,
      terminationDelivered: null,
      errorMessage: pendingMessage
    });
    if (!["queued", "running"].includes(pending.status)) {
      return { job: pending, previousStatus: stored.status, status: pending.status, delivered: false, method: null, errorMessage: pending.errorMessage ?? null };
    }
    appendLogLine(pending.logPath, `Cancellation pending: ${pendingMessage}`);
    return { job: pending, previousStatus: stored.status, status: "cancel-requested", delivered: false, method: null, errorMessage: pendingMessage };
  }

  if (alive(lastPid, identityOptions(latestSnapshot, options))) {
    const errorMessage = terminationError || `Could not terminate process ${lastPid}; it is still running.`;
    const failed = persistJob(workspaceRoot, {
      ...latestSnapshot,
      phase: "cancel-failed",
      pid: lastPid,
      terminationMethod: termination.method ?? null,
      terminationDelivered: false,
      errorMessage
    });
    if (!["queued", "running"].includes(failed.status)) {
      return { job: failed, previousStatus: stored.status, status: failed.status, delivered: false, method: termination.method ?? null, errorMessage: failed.errorMessage ?? null };
    }
    appendLogLine(failed.logPath, `Cancellation failed: ${errorMessage}`);
    return { job: failed, previousStatus: stored.status, status: "cancel-failed", delivered: false, method: termination.method ?? null, errorMessage };
  }

  const uncertainMessage = `Could not confirm process ${lastPid} during cancel; left cancel-requested for later reclaim.`;
  const uncertain = persistJob(workspaceRoot, {
    ...latestSnapshot,
    phase: "cancel-requested",
    pid: lastPid,
    terminationMethod: termination.method ?? null,
    terminationDelivered: false,
    errorMessage: uncertainMessage
  });
  if (!["queued", "running"].includes(uncertain.status)) {
    return { job: uncertain, previousStatus: stored.status, status: uncertain.status, delivered: false, method: termination.method ?? null, errorMessage: uncertain.errorMessage ?? null };
  }
  appendLogLine(uncertain.logPath, `Cancellation pending: ${uncertainMessage}`);
  return { job: uncertain, previousStatus: stored.status, status: "cancel-requested", delivered: false, method: termination.method ?? null, errorMessage: uncertainMessage };
}

function budgetExhaustedResult(workspaceRoot, job, message) {
  return {
    job: readStoredJob(workspaceRoot, job.id) ?? job,
    previousStatus: job.status,
    status: "cancel-requested",
    delivered: false,
    method: null,
    errorMessage: message
  };
}

/**
 * Cancel many jobs: mark cancel-requested immediately, then terminate in parallel child processes.
 * Jobs still unfinished when the budget elapses remain cancel-requested for later status/result reclaim.
 */
export async function cancelTrackedJobsParallel(workspaceRoot, jobs, options = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) {
    return [];
  }
  const budgetMs = options.budgetMs ?? DEFAULT_CANCEL_BUDGET_MS;
  const deadline = Date.now() + Math.max(0, budgetMs);
  const marked = list.map((job) => markJobCancelRequested(workspaceRoot, job, options));

  if (typeof options.cancelImpl === "function") {
    return Promise.all(marked.map(async (job) => {
      if (Date.now() >= deadline) {
        return budgetExhaustedResult(workspaceRoot, job, "Cancel budget exhausted; left cancel-requested.");
      }
      return options.cancelImpl(job);
    }));
  }

  // Child processes so Windows taskkill work does not serialize on one event loop.
  return Promise.all(marked.map((job) => cancelJobInSubprocess(workspaceRoot, job, {
    ...options,
    timeoutMs: Math.max(1_000, deadline - Date.now())
  })));
}

function cancelJobInSubprocess(workspaceRoot, job, options = {}) {
  return new Promise((resolve) => {
    const moduleUrl = new URL("./job-control.mjs", import.meta.url).href;
    const inline = `
import { cancelTrackedJob } from ${JSON.stringify(moduleUrl)};
const input = JSON.parse(process.argv[1]);
const result = cancelTrackedJob(input.workspaceRoot, input.job, {
  reason: input.reason,
  cancelledPhase: input.cancelledPhase,
  alreadyMarked: true,
  env: process.env
});
process.stdout.write(JSON.stringify(result));
`;
    const payload = JSON.stringify({
      workspaceRoot,
      job,
      reason: options.reason ?? null,
      cancelledPhase: options.cancelledPhase ?? "cancelled"
    });
    const child = spawn(process.execPath, ["--input-type=module", "-e", inline, payload], {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CANCEL_BUDGET_MS;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(budgetExhaustedResult(workspaceRoot, job, "Cancel subprocess timed out; left cancel-requested."));
    }, Math.max(500, timeoutMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(budgetExhaustedResult(workspaceRoot, job, error.message));
    });
    child.on("close", (code) => {
      try {
        if (code === 0 && stdout.trim()) {
          finish(JSON.parse(stdout));
          return;
        }
      } catch {
        // fall through
      }
      finish(budgetExhaustedResult(
        workspaceRoot,
        job,
        stderr.trim() || `Cancel subprocess exited ${code}`
      ));
    });
  });
}

function matchReference(jobs, reference, predicate = () => true) {
  const candidates = jobs.filter(predicate);
  if (!reference) {
    return candidates[0] ?? null;
  }
  const exact = candidates.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefix = candidates.filter((job) => job.id.startsWith(reference));
  if (prefix.length === 1) {
    return prefix[0];
  }
  if (prefix.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

export function readStoredJob(workspaceRoot, jobId) {
  const file = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(file) ? readJobFile(file) : null;
}

function applyJobFilters(jobs, options = {}) {
  let filtered = jobs;
  if (options.kind) {
    const kind = String(options.kind).toLowerCase();
    filtered = filtered.filter((job) => String(job.kind ?? "").toLowerCase() === kind);
  }
  if (options.status) {
    const status = String(options.status).toLowerCase();
    filtered = filtered.filter((job) => String(job.status ?? "").toLowerCase() === status);
  }
  return filtered;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const enrichOptions = { maxProgressLines: options.maxProgressLines };
  const jobs = applyJobFilters(
    sortJobsNewestFirst(reconciledJobs(workspaceRoot, options)),
    options
  );
  // --limit caps the listed jobs. Bare --all with no explicit maxJobs stays
  // unlimited.
  const maxJobs = options.maxJobs != null
    ? options.maxJobs
    : (options.all ? null : DEFAULT_MAX_STATUS_JOBS);
  const selected = maxJobs == null ? jobs : jobs.slice(0, maxJobs);
  const running = jobs
    .filter((job) => ["queued", "running"].includes(job.status))
    .map((job) => enrichJob(job, enrichOptions));
  const latestFinishedRaw = jobs.find((job) => !["queued", "running"].includes(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, enrichOptions) : null;
  const recent = selected
    .filter((job) => !["queued", "running"].includes(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, enrichOptions));
  return {
    workspaceRoot,
    jobs: selected.map((job) => enrichJob(job, enrichOptions)),
    running,
    latestFinished,
    recent,
    filters: {
      kind: options.kind ?? null,
      status: options.status ?? null,
      limit: maxJobs,
      all: Boolean(options.all)
    }
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selected = matchReference(sortJobsNewestFirst(reconciledJobs(workspaceRoot)), reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Use $grok-jobs to list known jobs.`);
  }
  return { workspaceRoot, job: enrichJob(selected, { maxProgressLines: options.maxProgressLines }) };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconciledJobs(workspaceRoot, options));
  const finished = matchReference(jobs, reference, (job) => ["completed", "failed", "cancelled"].includes(job.status));
  if (finished) {
    return { workspaceRoot, job: finished };
  }
  const active = matchReference(jobs, reference, (job) => ["queued", "running"].includes(job.status));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Use $grok-jobs status ${active.id}.`);
  }
  throw new Error(reference
    ? `No finished job found for "${reference}".`
    : "No finished Grok jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const active = sortJobsNewestFirst(listJobs(workspaceRoot))
    .filter((job) => ["queued", "running"].includes(job.status));
  if (reference) {
    const selected = matchReference(active, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }
  const scoped = applyJobFilters(active, options);
  if (scoped.length === 1) {
    return { workspaceRoot, job: scoped[0] };
  }
  if (scoped.length > 1) {
    throw new Error("Multiple Grok jobs are active. Pass a job id to cancel, or use --all.");
  }
  throw new Error("No active Grok jobs to cancel.");
}

/**
 * Resolve every active job eligible for bulk cancel.
 * Operates on the current workspace.
 */
export function resolveCancelableJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const active = sortJobsNewestFirst(listJobs(workspaceRoot))
    .filter((job) => ["queued", "running"].includes(job.status));
  const scoped = applyJobFilters(active, options);
  return { workspaceRoot, jobs: scoped };
}

function parseDurationToMs(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`);
    }
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use e.g. 7d, 24h, 90m, 30s, or milliseconds.`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

export function parseDurationMs(value) {
  return parseDurationToMs(value);
}

function jobAgeMs(job, now = Date.now()) {
  const stamp = Date.parse(job.updatedAt ?? job.completedAt ?? job.createdAt ?? "");
  return Number.isFinite(stamp) ? Math.max(0, now - stamp) : 0;
}

/**
 * Select jobs for cleanup. Active (queued/running) jobs are never selected.
 */
export function selectJobsForCleanup(jobs, options = {}) {
  const now = options.nowMs ?? Date.now();
  const keep = options.keep == null ? null : Number(options.keep);
  if (keep != null && (!Number.isInteger(keep) || keep < 0)) {
    throw new Error("--keep must be a non-negative integer.");
  }
  const olderThanMs = options.olderThanMs ?? parseDurationToMs(options.olderThan);
  const terminal = sortJobsNewestFirst(jobs)
    .filter((job) => !["queued", "running"].includes(job.status));

  let candidates = terminal;
  if (olderThanMs != null) {
    candidates = candidates.filter((job) => jobAgeMs(job, now) >= olderThanMs);
  }
  if (keep != null) {
    // Keep the newest `keep` terminal jobs; delete the rest (intersect with older-than when set).
    const protectedIds = new Set(terminal.slice(0, keep).map((job) => job.id));
    candidates = candidates.filter((job) => !protectedIds.has(job.id));
  }
  if (olderThanMs == null && keep == null) {
    // Default: keep the newest DEFAULT_MAX_STATUS_JOBS * index-friendly set — require an explicit filter.
    throw new Error("Pass --older-than <duration> and/or --keep <N> to select jobs for cleanup.");
  }
  return candidates;
}

function unlinkIfExists(target) {
  try {
    if (target && fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
  } catch {
    // Best-effort cleanup.
  }
  return false;
}

/**
 * Remove terminal jobs from the index and delete their on-disk artifacts.
 */
export function cleanupJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const selected = selectJobsForCleanup(jobs, options);
  const dryRun = Boolean(options.dryRun);
  const removed = [];

  for (const job of selected) {
    const paths = {
      jobFile: resolveJobFile(workspaceRoot, job.id),
      logFile: job.logPath || resolveJobLogFile(workspaceRoot, job.id)
    };
    if (!dryRun) {
      unlinkIfExists(paths.jobFile);
      unlinkIfExists(paths.logFile);
    }
    removed.push({
      id: job.id,
      kind: job.kind,
      status: job.status,
      updatedAt: job.updatedAt ?? null,
      paths
    });
  }

  if (!dryRun && removed.length > 0) {
    const removeIds = new Set(removed.map((entry) => entry.id));
    // Allow empty index when every job is intentionally deleted.
    updateState(workspaceRoot, (state) => {
      state.jobs = state.jobs.filter((job) => !removeIds.has(job.id));
      state.__allowEmptyJobs = true;
    });
  }

  return {
    workspaceRoot,
    dryRun,
    removedCount: removed.length,
    removed
  };
}

/** Bundle a job and its log into a portable JSON payload. */
export function exportJobBundle(cwd, reference, options = {}) {
  if (!options.out) {
    throw new Error("Export requires an explicit output path.");
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconciledJobs(workspaceRoot));
  const selected = matchReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}".`);
  }
  const stored = readStoredJob(workspaceRoot, selected.id) ?? selected;
  const logPath = stored.logPath || resolveJobLogFile(workspaceRoot, selected.id);
  let logText = null;
  if (logPath && fs.existsSync(logPath)) {
    logText = fs.readFileSync(logPath, "utf8");
  }
  const bundle = {
    exportedAt: nowIso(),
    workspaceRoot,
    job: stored,
    log: logText
  };

  const outPath = path.resolve(cwd, options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    workspaceRoot,
    jobId: selected.id,
    outPath,
    bytes: Buffer.byteLength(JSON.stringify(bundle), "utf8"),
    hasLog: logText != null
  };
}

/**
 * Read job log lines (tail). Returns structured payload for status --logs.
 */
export function readJobLogs(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconciledJobs(workspaceRoot));
  const selected = reference
    ? matchReference(jobs, reference)
    : (jobs[0] ?? null);
  if (!selected) {
    throw new Error(reference
      ? `No job found for "${reference}".`
      : "No Grok jobs found. Pass a job id to status --logs.");
  }
  const stored = readStoredJob(workspaceRoot, selected.id) ?? selected;
  const logPath = stored.logPath || resolveJobLogFile(workspaceRoot, selected.id);
  const tail = options.tail == null ? DEFAULT_LOG_TAIL_LINES : Number(options.tail);
  if (!Number.isFinite(tail) || tail < 0 || !Number.isInteger(tail)) {
    throw new Error("--logs must be a non-negative integer.");
  }
  if (!logPath || !fs.existsSync(logPath)) {
    return {
      workspaceRoot,
      jobId: selected.id,
      logPath: logPath ?? null,
      exists: false,
      lines: [],
      totalLines: 0,
      tail
    };
  }
  const text = fs.readFileSync(logPath, "utf8");
  const allLines = text.split(/\r?\n/);
  // Drop trailing empty line from final newline.
  if (allLines.length && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const lines = tail === 0 ? [] : allLines.slice(-tail);
  return {
    workspaceRoot,
    jobId: selected.id,
    logPath,
    exists: true,
    lines,
    totalLines: allLines.length,
    tail
  };
}

/** Resolve a confirmed Grok session for explicit --session-id / --resume-job. */
export function resolveResumeTarget(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconciledJobs(workspaceRoot, options));

  if (options.resumeJob) {
    const selected = matchReference(jobs, options.resumeJob);
    if (!selected) {
      throw new Error(`No job found for --resume-job "${options.resumeJob}".`);
    }
    if (selected.kind !== "task") {
      throw new Error(`Job ${selected.id} is kind "${selected.kind}"; only task jobs are resumable.`);
    }
    if (["queued", "running"].includes(selected.status)) {
      throw new Error(`Cannot resume job ${selected.id} while it is still ${selected.status}.`);
    }
    if (!selected.sessionId || !selected.sessionConfirmed) {
      throw new Error(
        `Job ${selected.id} has no confirmed Grok session to resume `
        + `(sessionId=${selected.sessionId ?? "none"}, confirmed=${Boolean(selected.sessionConfirmed)}).`
      );
    }
    if (options.sessionId && options.sessionId !== selected.sessionId) {
      throw new Error(
        `--session-id "${options.sessionId}" does not match job ${selected.id} session ${selected.sessionId}.`
      );
    }
    return {
      sessionId: selected.sessionId,
      source: "resume-job",
      jobId: selected.id,
      status: selected.status,
      summary: selected.summary,
      updatedAt: selected.updatedAt,
      sessionConfirmed: true,
      resumable: Boolean(selected.resumable)
    };
  }

  if (options.sessionId) {
    const sessionId = String(options.sessionId).trim();
    if (!sessionId) {
      throw new Error("--session-id requires a non-empty value.");
    }
    const matches = jobs.filter((job) =>
      job.kind === "task"
      && job.sessionId === sessionId
      && job.sessionConfirmed === true
    );
    if (matches.length === 0) {
      throw new Error(
        `No confirmed Grok task session "${sessionId}" was found in this workspace. `
        + "Use a session id from a previous $grok-jobs result or status report."
      );
    }
    const preferred = matches.find((job) => job.resumable) ?? matches[0];
    if (["queued", "running"].includes(preferred.status)) {
      throw new Error(`Cannot resume session ${sessionId} while job ${preferred.id} is still ${preferred.status}.`);
    }
    return {
      sessionId,
      source: "session-id",
      jobId: preferred.id,
      status: preferred.status,
      summary: preferred.summary,
      updatedAt: preferred.updatedAt,
      sessionConfirmed: true,
      resumable: Boolean(preferred.resumable)
    };
  }

  return null;
}
