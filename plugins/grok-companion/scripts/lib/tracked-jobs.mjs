import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateJobFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";
import { getProcessIdentity } from "./process.mjs";

const PROGRESS_MIN_INTERVAL_MS = 500;
const SILENT_PROGRESS_EVENTS = /thought|thinking|reasoning|^text$/;

export function nowIso() {
  return new Date().toISOString();
}

function warnLogIo(kind, logPath, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[grok] Failed to ${kind} job log ${logPath ?? "(none)"}: ${message}\n`);
}

export function appendLogLine(logPath, message) {
  try {
    const value = String(message ?? "").trim();
    if (logPath && value) {
      fs.appendFileSync(logPath, `[${nowIso()}] ${value}\n`, "utf8");
    }
  } catch (error) {
    warnLogIo("append", logPath, error);
  }
}

export function appendLogBlock(logPath, title, body) {
  try {
    const value = String(body ?? "").trimEnd();
    if (logPath && value) {
      fs.appendFileSync(logPath, `\n[${nowIso()}] ${title}\n${value}\n`, "utf8");
    }
  } catch (error) {
    warnLogIo("append", logPath, error);
  }
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logPath = resolveJobLogFile(workspaceRoot, jobId);
  try {
    fs.writeFileSync(logPath, "", "utf8");
  } catch (error) {
    warnLogIo("create", logPath, error);
  }
  appendLogLine(logPath, `Starting ${title}.`);
  return logPath;
}

export function createJobRecord(base) {
  return {
    ...base,
    createdAt: nowIso()
  };
}

export function createProgressReporter({ stderr = false, logPath = null } = {}) {
  if (!stderr && !logPath) {
    return null;
  }
  return (message) => {
    const value = String(message ?? "").trim();
    if (!value) {
      return;
    }
    if (stderr) {
      process.stderr.write(`[grok] ${value}\n`);
    }
    appendLogLine(logPath, value);
  };
}

function storedJob(workspaceRoot, jobId) {
  const file = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(file) ? readJobFile(file) : null;
}

export function indexJobRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    phase: record.phase,
    pid: record.pid ?? null,
    processName: record.processName ?? null,
    processStartedAtMs: record.processStartedAtMs ?? null,
    workerLaunchStartedAt: record.workerLaunchStartedAt ?? null,
    workerSpawnedAt: record.workerSpawnedAt ?? null,
    cwd: record.cwd,
    workspaceRoot: record.workspaceRoot,
    summary: record.summary,
    promptSummary: record.promptSummary ?? record.summary,
    sessionId: record.sessionId ?? null,
    sessionConfirmed: Boolean(record.sessionConfirmed),
    resumable: Boolean(record.resumable),
    resultPath: record.resultPath ?? null,
    logPath: record.logPath ?? null,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    lastProgressAt: record.lastProgressAt ?? null,
    progress: record.progress ?? null,
    cancelRequestedAt: record.cancelRequestedAt ?? null,
    cancelledAt: record.cancelledAt ?? null,
    terminationMethod: record.terminationMethod ?? null,
    terminationDelivered: record.terminationDelivered ?? null,
    exitCode: record.exitCode ?? null,
    durationMs: record.durationMs ?? null,
    errorMessage: record.errorMessage ?? null
  };
}

export function publishDetachedWorkerPid(workspaceRoot, jobId, pid, identity = null) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const published = updateJobFile(workspaceRoot, jobId, (latest) => {
    if (!latest || (Number.isInteger(latest.pid) && latest.pid > 0)) {
      return null;
    }
    if (!["queued", "running"].includes(latest.status)) {
      return null;
    }
    return {
      ...latest,
      pid,
      processName: identity?.name ?? path.basename(process.execPath),
      processStartedAtMs: identity?.startedAtMs ?? Date.now(),
      workerSpawnedAt: nowIso()
    };
  });
  if (published && Number.isInteger(published.pid) && published.pid > 0) {
    upsertJob(workspaceRoot, indexJobRecord(published));
  }
  return published;
}

function writeIndex(workspaceRoot, record) {
  upsertJob(workspaceRoot, indexJobRecord(record));
}

function warnProgressFailure(jobId, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[grok] progress update failed for ${jobId}: ${message}\n`);
}

export function createJobProgressUpdater({ workspaceRoot, jobId, logPath = null } = {}) {
  let lastWriteAt = 0;
  let lastPhase = null;
  let lastSessionId = null;
  let pendingIndexRecord = null;
  let lastIndexWriteAt = 0;

  const flushIndex = (force = false) => {
    if (!pendingIndexRecord) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastIndexWriteAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    const record = pendingIndexRecord;
    pendingIndexRecord = null;
    lastIndexWriteAt = now;
    writeIndex(workspaceRoot, record);
  };

  return (telemetry) => {
    try {
      if (!telemetry || typeof telemetry !== "object") {
        return;
      }
      if (telemetry.suppressProgress) {
        return;
      }
      const eventType = String(telemetry.eventType ?? "unknown").toLowerCase();
      if (SILENT_PROGRESS_EVENTS.test(eventType)) {
        return;
      }

      const nextPhase = telemetry.phase ?? null;
      const nextSessionId = telemetry.sessionId ?? null;
      const phaseChanged = nextPhase != null && nextPhase !== lastPhase;
      const sessionChanged = nextSessionId != null && nextSessionId !== lastSessionId;
      const now = Date.now();
      if (!phaseChanged && !sessionChanged && now - lastWriteAt < PROGRESS_MIN_INTERVAL_MS) {
        return;
      }

      const progress = {
        message: telemetry.message || telemetry.eventType || "Grok progress",
        eventType: telemetry.eventType ?? "unknown",
        at: telemetry.at ?? nowIso()
      };

      const patched = updateJobFile(workspaceRoot, jobId, (latest) => {
        if (!["queued", "running"].includes(latest.status)) {
          return null;
        }
        const confirmedSessionId = telemetry.sessionId ?? null;
        return {
          ...latest,
          phase: telemetry.phase ?? latest.phase ?? "running",
          sessionId: confirmedSessionId ?? latest.sessionId ?? null,
          sessionConfirmed: confirmedSessionId ? true : Boolean(latest.sessionConfirmed),
          resumable: false,
          lastProgressAt: progress.at,
          progress
        };
      });

      if (!patched || !["queued", "running"].includes(patched.status)) {
        return;
      }

      lastWriteAt = now;
      lastPhase = patched.phase ?? lastPhase;
      lastSessionId = patched.sessionId ?? lastSessionId;
      pendingIndexRecord = patched;
      // Coalesce index writes: flush immediately on phase/session change, else throttle.
      flushIndex(phaseChanged || sessionChanged);

      if (progress.message) {
        appendLogLine(logPath ?? patched.logPath, progress.message);
      }
    } catch (error) {
      warnProgressFailure(jobId, error);
    }
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const identity = getProcessIdentity(process.pid, {
    cwd: job.cwd,
    env: options.env
  });
  const running = {
    ...job,
    status: "running",
    phase: "starting",
    startedAt: job.startedAt ?? nowIso(),
    pid: process.pid,
    processName: identity?.name ?? path.basename(process.execPath),
    processStartedAtMs: identity?.startedAtMs ?? Date.now(),
    workerSpawnedAt: job.workerSpawnedAt ?? nowIso(),
    logPath: options.logPath ?? job.logPath ?? null,
    resultPath: resolveJobFile(job.workspaceRoot, job.id)
  };
  writeJobFile(job.workspaceRoot, job.id, running);
  writeIndex(job.workspaceRoot, running);

  try {
    const execution = await runner();
    const latest = storedJob(job.workspaceRoot, job.id);
    if (latest?.status === "cancelled") {
      return { ...execution, exitCode: 130, cancelled: true };
    }
    const status = execution.exitCode === 0 ? "completed" : "failed";
    const { request: _request, ...completedBase } = latest ?? running;
    const sessionConfirmed = Boolean(execution.sessionConfirmed || completedBase.sessionConfirmed);
    const final = {
      ...completedBase,
      status,
      phase: status,
      pid: null,
      completedAt: nowIso(),
      sessionId: execution.sessionId ?? completedBase.sessionId ?? null,
      sessionConfirmed,
      resumable: completedBase.kind === "task" && sessionConfirmed,
      exitCode: execution.exitCode ?? execution.payload?.exitCode ?? null,
      durationMs: execution.durationMs ?? execution.payload?.durationMs ?? null,
      result: execution.payload,
      rendered: execution.rendered,
      errorMessage: execution.errorMessage ?? null
    };
    // Terminal write first; CAS keeps cancelled if cancel won the race after the check above.
    writeJobFile(job.workspaceRoot, job.id, final);
    const stored = storedJob(job.workspaceRoot, job.id) ?? final;
    writeIndex(job.workspaceRoot, stored);
    if (stored.status === "cancelled") {
      appendLogLine(stored.logPath, "Runner finished after cancellation; keeping cancelled status.");
      return { ...execution, exitCode: 130, cancelled: true };
    }
    appendLogBlock(stored.logPath, "Final output", execution.rendered || execution.payload?.rawOutput);
    return execution;
  } catch (error) {
    const latest = storedJob(job.workspaceRoot, job.id);
    if (latest?.status === "cancelled") {
      return { exitCode: 130, cancelled: true, payload: null, rendered: "" };
    }
    const message = error instanceof Error ? error.message : String(error);
    const { request: _request, ...failedBase } = latest ?? running;
    const final = {
      ...failedBase,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      resumable: failedBase.kind === "task" && Boolean(failedBase.sessionConfirmed),
      errorMessage: message
    };
    writeJobFile(job.workspaceRoot, job.id, final);
    const stored = storedJob(job.workspaceRoot, job.id) ?? final;
    writeIndex(job.workspaceRoot, stored);
    if (stored.status === "cancelled") {
      return { exitCode: 130, cancelled: true, payload: null, rendered: "" };
    }
    appendLogLine(stored.logPath, `Failed: ${message}`);
    throw error;
  }
}
