import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonFileAtomic } from "./fs.mjs";
import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const MAX_JOBS = 50;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const STATE_LOCK_NAME = ".state.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "completed", "failed"]);
const lockWaiter = new Int32Array(new SharedArrayBuffer(4));

/** Index retention cap — exported for cleanup / help text. */
export const JOB_INDEX_LIMIT = MAX_JOBS;

let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
let staleLockMs = DEFAULT_STALE_LOCK_MS;
let sleepSyncImpl = sleepSyncDefault;
let isProcessAliveImpl = isProcessAlive;
let nowMsImpl = () => Date.now();

function nowIso() {
  return new Date().toISOString();
}

function sleepSyncDefault(milliseconds) {
  Atomics.wait(lockWaiter, 0, 0, milliseconds);
}

/** @internal test hooks for lock timing/backoff */
export function setStateLockTestHooks(hooks = null) {
  if (!hooks) {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
    staleLockMs = DEFAULT_STALE_LOCK_MS;
    sleepSyncImpl = sleepSyncDefault;
    isProcessAliveImpl = isProcessAlive;
    nowMsImpl = () => Date.now();
    return;
  }
  if (hooks.lockTimeoutMs != null) {
    lockTimeoutMs = hooks.lockTimeoutMs;
  }
  if (hooks.staleLockMs != null) {
    staleLockMs = hooks.staleLockMs;
  }
  if (hooks.sleepSync) {
    sleepSyncImpl = hooks.sleepSync;
  }
  if (hooks.isProcessAlive) {
    isProcessAliveImpl = hooks.isProcessAlive;
  }
  if (hooks.nowMs) {
    nowMsImpl = hooks.nowMs;
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

export function resolveStateRootInfo(env = process.env, homeDir = os.homedir()) {
  if (env.GROK_COMPANION_HOME) {
    return {
      path: path.resolve(env.GROK_COMPANION_HOME),
      source: "GROK_COMPANION_HOME"
    };
  }
  if (env.PLUGIN_DATA) {
    return {
      path: path.resolve(env.PLUGIN_DATA),
      source: "PLUGIN_DATA"
    };
  }
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(homeDir, ".codex");
  return {
    path: path.join(codexHome, "state", "plugins", "grok-companion"),
    source: env.CODEX_HOME ? "CODEX_HOME" : "default"
  };
}

export function resolveStateRoot() {
  return resolveStateRootInfo().path;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    // Hash the resolved input when a real path is unavailable.
  }
  const slug = (path.basename(workspaceRoot) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function indexSummaryFromJobRecord(job, filePath) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    phase: job.phase,
    pid: job.pid ?? null,
    processName: job.processName ?? null,
    processStartedAtMs: job.processStartedAtMs ?? null,
    workerLaunchStartedAt: job.workerLaunchStartedAt ?? null,
    workerSpawnedAt: job.workerSpawnedAt ?? null,
    cwd: job.cwd,
    workspaceRoot: job.workspaceRoot,
    summary: job.summary,
    promptSummary: job.promptSummary ?? job.summary,
    sessionId: job.sessionId ?? null,
    sessionConfirmed: Boolean(job.sessionConfirmed),
    resumable: Boolean(job.resumable),
    resultPath: job.resultPath ?? filePath ?? null,
    logPath: job.logPath ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    lastProgressAt: job.lastProgressAt ?? null,
    progress: job.progress ?? null,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
    cancelledAt: job.cancelledAt ?? null,
    terminationMethod: job.terminationMethod ?? null,
    terminationDelivered: job.terminationDelivered ?? null,
    exitCode: job.exitCode ?? null,
    durationMs: job.durationMs ?? null,
    errorMessage: job.errorMessage ?? null,
    updatedAt: job.updatedAt ?? job.completedAt ?? job.lastProgressAt ?? job.createdAt ?? nowIso()
  };
}

function rebuildStateFromJobFiles(cwd) {
  const state = defaultState();
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return state;
  }
  const jobs = [];
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(jobsDir, name);
    try {
      const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (job && typeof job === "object" && job.id) {
        jobs.push(indexSummaryFromJobRecord(job, filePath));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[grok] Skipping corrupt job file during state rebuild: ${filePath}: ${message}\n`);
    }
  }
  state.jobs = pruneJobs(jobs);
  return state;
}

function backupCorruptStateFile(file, error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const backup = `${file}.corrupt.${Date.now()}`;
    fs.copyFileSync(file, backup);
    process.stderr.write(`[grok] state.json is corrupt (${message}); backed up to ${backup}\n`);
    return backup;
  } catch (backupError) {
    const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
    process.stderr.write(`[grok] state.json is corrupt (${message}); backup failed: ${backupMessage}\n`);
    return null;
  }
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    backupCorruptStateFile(file, error);
    return rebuildStateFromJobFiles(cwd);
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const active = sorted.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status));
  const terminal = sorted.filter((job) => TERMINAL_JOB_STATUSES.has(job.status));
  const terminalBudget = Math.max(0, MAX_JOBS - active.length);
  return [...active, ...terminal.slice(0, terminalBudget)]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function parseLockContents(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const token = (lines[0] ?? "").trim();
  const pid = Number.parseInt((lines[1] ?? "").trim(), 10);
  return {
    token,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null
  };
}

function tryRecoverStaleLock(lockFile) {
  try {
    const stat = fs.statSync(lockFile);
    const { pid } = parseLockContents(fs.readFileSync(lockFile, "utf8"));
    const staleByTime = nowMsImpl() - stat.mtimeMs > staleLockMs;
    if (pid != null) {
      // Dead holder can always be reclaimed regardless of mtime.
      if (!isProcessAliveImpl(pid)) {
        fs.unlinkSync(lockFile);
        return true;
      }
      return false;
    }
    // Legacy locks without a pid fall back to mtime-only stale detection.
    if (staleByTime) {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch {
    // Lock disappeared between exists and read, or unlink raced — retry acquire.
    return true;
  }
  return false;
}

function renewLockLease(lockFile, lockToken) {
  try {
    const current = parseLockContents(fs.readFileSync(lockFile, "utf8"));
    if (current.token === lockToken) {
      fs.writeFileSync(lockFile, `${lockToken}\n${process.pid}\n${nowMsImpl()}\n`, "utf8");
    }
  } catch {
    // Best-effort heartbeat; acquire/release still own the critical section.
  }
}

function withFileLock(lockFile, operation) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lockToken = `${process.pid}-${nowMsImpl()}-${Math.random().toString(36).slice(2)}`;
  const started = nowMsImpl();
  let descriptor = null;
  let attempt = 0;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, `${lockToken}\n${process.pid}\n${nowMsImpl()}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryRecoverStaleLock(lockFile)) {
        continue;
      }
      if (nowMsImpl() - started >= lockTimeoutMs) {
        throw new Error(`Timed out waiting for Grok companion state lock: ${lockFile}`);
      }
      const delay = Math.min(20 * (2 ** Math.min(attempt, 5)), 500);
      attempt += 1;
      sleepSyncImpl(delay);
    }
  }

  try {
    renewLockLease(lockFile, lockToken);
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (parseLockContents(fs.readFileSync(lockFile, "utf8")).token === lockToken) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Another process can recover a stale lock if cleanup is interrupted.
    }
  }
}

function withStateLock(cwd, operation) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_NAME);
  return withFileLock(lockFile, operation);
}

function jobLockFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `.${jobId}.lock`);
}

function withJobLock(cwd, jobId, operation) {
  ensureStateDir(cwd);
  return withFileLock(jobLockFile(cwd, jobId), operation);
}

function readJobFileUnlocked(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[grok] Failed to parse job file ${file}: ${message}\n`);
    return {
      id: path.basename(file, ".json"),
      status: "failed",
      phase: "corrupt",
      corrupt: true,
      errorMessage: `Job file is corrupt or unreadable: ${file}`,
      resultPath: file
    };
  }
}

function isTerminalStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Decide whether payload may replace current on disk.
 * Terminal statuses cannot be overwritten by non-terminal ones, and the first
 * terminal status wins over a competing different terminal (e.g. cancelled vs completed).
 */
function resolveJobWrite(current, payload) {
  if (!current || current.corrupt) {
    return payload;
  }
  if (isTerminalStatus(current.status)) {
    if (!isTerminalStatus(payload?.status)) {
      return null;
    }
    if (payload.status !== current.status) {
      return null;
    }
    const merged = { ...current, ...payload, status: current.status };
    // Orphan reconciliation may mark failed/process-exited while a dying worker
    // still finalizes the same failed status. Keep the orphan attribution.
    if (
      current.status === "failed"
      && (current.phase === "process-exited" || payload.phase === "process-exited")
    ) {
      merged.phase = "process-exited";
      if (current.phase === "process-exited" && current.errorMessage) {
        merged.errorMessage = current.errorMessage;
      } else if (payload.phase === "process-exited" && payload.errorMessage) {
        merged.errorMessage = payload.errorMessage;
      }
    }
    return merged;
  }
  return payload;
}

function saveStateUnlocked(cwd, state) {
  const file = resolveStateFile(cwd);
  let previousJobs = [];
  let previousConfig = defaultState().config;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      previousJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      previousConfig = { ...defaultState().config, ...(parsed.config ?? {}) };
    } catch {
      // Corrupt index: rebuild from job files so prune cannot wipe real work.
      const rebuilt = rebuildStateFromJobFiles(cwd);
      previousJobs = rebuilt.jobs;
      previousConfig = rebuilt.config;
    }
  }

  const incomingJobs = Array.isArray(state.jobs) ? state.jobs : [];
  // Never replace a non-empty index with an empty default after a corrupt read.
  const jobs = incomingJobs.length === 0 && previousJobs.length > 0 && state.__allowEmptyJobs !== true
    ? previousJobs
    : incomingJobs;
  const config = {
    ...defaultState().config,
    ...previousConfig,
    ...(state.config ?? {})
  };

  ensureStateDir(cwd);
  const value = {
    version: STATE_VERSION,
    config,
    jobs: pruneJobs(jobs)
  };
  writeJsonFileAtomic(file, value);
  const retained = new Set(value.jobs.map((job) => job.id));
  const prunedIds = [];
  for (const job of previousJobs) {
    if (retained.has(job.id)) {
      continue;
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      continue;
    }
    prunedIds.push(job.id);
    for (const target of [
      path.join(resolveJobsDir(cwd), `${job.id}.json`),
      job.logPath || path.join(resolveJobsDir(cwd), `${job.id}.log`)
    ]) {
      try {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      } catch {
        // Pruning the index must not make an otherwise valid state update fail.
      }
    }
  }
  if (prunedIds.length > 0) {
    const sample = prunedIds.slice(0, 3).join(", ");
    const more = prunedIds.length > 3 ? ` (+${prunedIds.length - 3} more)` : "";
    process.stderr.write(
      `[grok] Pruned ${prunedIds.length} old job(s) from the index (limit ${MAX_JOBS}): `
      + `${sample}${more}. Export or clean up retained jobs with $grok-jobs.\n`
    );
  }
  return value;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutator) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutator(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertJob(cwd, patch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === patch.id);
    if (index === -1) {
      state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
    } else {
      state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: timestamp };
    }
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = { ...state.config, [key]: value };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/**
 * Atomically write a job file under a per-job lock with terminal-state CAS.
 * Returns the path always; the on-disk record is unchanged when the write is rejected.
 */
export function writeJobFile(cwd, jobId, payload) {
  return withJobLock(cwd, jobId, () => {
    const file = resolveJobFile(cwd, jobId);
    const current = readJobFileUnlocked(file);
    const next = resolveJobWrite(current, payload);
    if (next) {
      writeJsonFileAtomic(file, next);
    }
    return file;
  });
}

/**
 * Read-modify-write a job file under the per-job lock.
 * mutator receives the current record and returns the next payload, or null to skip.
 * Returns the on-disk record after the attempt (or null if missing).
 */
export function updateJobFile(cwd, jobId, mutator) {
  return withJobLock(cwd, jobId, () => {
    const file = resolveJobFile(cwd, jobId);
    const current = readJobFileUnlocked(file);
    if (!current || current.corrupt) {
      return current;
    }
    const proposed = mutator(current);
    if (!proposed) {
      return current;
    }
    const next = resolveJobWrite(current, proposed);
    if (!next) {
      return current;
    }
    writeJsonFileAtomic(file, next);
    return next;
  });
}

export function readJobFile(file) {
  const parsed = readJobFileUnlocked(file);
  if (!parsed) {
    throw new Error(`Job file not found: ${file}`);
  }
  return parsed;
}

export function isJobTerminalStatus(status) {
  return isTerminalStatus(status);
}
