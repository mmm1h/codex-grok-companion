import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildStatusSnapshot,
  cancelTrackedJobsParallel,
  enrichJob,
  markJobCancelRequested,
  PROGRESS_PREVIEW_TAIL_BYTES,
  reconcileOrphanedJob,
  reconcileSessionJobs,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/grok-companion/scripts/lib/job-control.mjs";
import { listJobs, readJobFile, resolveJobFile, saveState, writeJobFile } from "../plugins/grok-companion/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/grok-companion/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

function withStateHome(t) {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, stateHome };
}

function seedJobs(repo, jobs) {
  saveState(repo, {
    config: {},
    jobs: jobs.map((job) => {
      writeJobFile(repo, job.id, job);
      return job;
    })
  });
}

test("resolveResultJob errors when the job is still running", (t) => {
  const { repo } = withStateHome(t);
  seedJobs(repo, [
    {
      id: "task-still-running",
      kind: "task",
      status: "running",
      phase: "tool",
      updatedAt: "2026-07-29T10:00:00.000Z"
    },
    {
      id: "task-done",
      kind: "task",
      status: "completed",
      phase: "completed",
      updatedAt: "2026-07-29T09:00:00.000Z"
    }
  ]);
  assert.throws(
    () => resolveResultJob(repo, "task-still-running"),
    /still running/
  );
});

test("resolveResultJob errors when no finished jobs exist", (t) => {
  const { repo } = withStateHome(t);
  seedJobs(repo, []);
  assert.throws(
    () => resolveResultJob(repo),
    /No finished Grok jobs found/
  );
  seedJobs(repo, [
    {
      id: "task-only-active",
      kind: "task",
      status: "running",
      phase: "tool",
      updatedAt: "2026-07-29T10:00:00.000Z"
    }
  ]);
  // No id + only active jobs: surfaces the active job as still running (not "no finished").
  assert.throws(
    () => resolveResultJob(repo),
    /still running/
  );
});

test("resolveCancelableJob errors with no active, multiple active, and missing id", (t) => {
  const { repo } = withStateHome(t);

  seedJobs(repo, [
    {
      id: "task-finished",
      kind: "task",
      status: "completed",
      phase: "completed",
      updatedAt: "2026-07-29T08:00:00.000Z"
    }
  ]);
  assert.throws(() => resolveCancelableJob(repo), /No active Grok jobs to cancel/);

  seedJobs(repo, [
    {
      id: "task-one",
      kind: "task",
      status: "running",
      phase: "tool",
      updatedAt: "2026-07-29T10:00:00.000Z"
    },
    {
      id: "task-two",
      kind: "task",
      status: "queued",
      phase: "queued",
      updatedAt: "2026-07-29T09:30:00.000Z"
    },
    {
      id: "task-done",
      kind: "task",
      status: "completed",
      phase: "completed",
      updatedAt: "2026-07-29T08:00:00.000Z"
    }
  ]);
  assert.throws(() => resolveCancelableJob(repo), /Pass a job id/);
  assert.throws(() => resolveCancelableJob(repo, "task-missing"), /No active job found/);

  const single = resolveCancelableJob(repo, "task-one");
  assert.equal(single.job.id, "task-one");
});

test("reconcileSessionJobs marks dead-PID orphans failed for the workspace", (t) => {
  const { repo } = withStateHome(t);
  const deadPid = 9_999_991;
  seedJobs(repo, [
    {
      id: "task-orphan-here",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: deadPid,
      sessionConfirmed: true,
      cwd: repo,
      workspaceRoot: repo,
      logPath: path.join(repo, "orphan-a.log"),
      updatedAt: "2026-07-29T10:00:00.000Z"
    },
    {
      id: "task-other-session",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: deadPid,
      sessionConfirmed: true,
      cwd: repo,
      workspaceRoot: repo,
      logPath: path.join(repo, "orphan-b.log"),
      updatedAt: "2026-07-29T10:00:00.000Z"
    }
  ]);
  fs.writeFileSync(path.join(repo, "orphan-a.log"), "", "utf8");
  fs.writeFileSync(path.join(repo, "orphan-b.log"), "", "utf8");

  const reconciled = reconcileSessionJobs(repo, { isProcessAliveImpl: () => false });
  assert.equal(reconciled.find((job) => job.id === "task-orphan-here")?.status, "failed");
  assert.equal(listJobs(repo).find((job) => job.id === "task-other-session")?.status, "failed");
});

test("markJobCancelRequested persists cancel-requested without terminating", (t) => {
  const { repo } = withStateHome(t);
  const job = {
    id: "task-mark-only",
    kind: "task",
    status: "running",
    phase: "tool",
    pid: 4242,
    cwd: repo,
    workspaceRoot: repo,
    logPath: path.join(repo, "mark.log"),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(job.logPath, "", "utf8");
  writeJobFile(repo, job.id, job);
  saveState(repo, { config: {}, jobs: [job] });

  const marked = markJobCancelRequested(repo, job, { reason: "budget test" });
  assert.equal(marked.phase, "cancel-requested");
  assert.equal(marked.status, "running");
  assert.ok(marked.cancelRequestedAt);
  const stored = readJobFile(resolveJobFile(repo, job.id));
  assert.equal(stored.phase, "cancel-requested");
  assert.equal(stored.pid, 4242);
});

test("cancelTrackedJobsParallel marks all jobs then cancels via cancelImpl under budget", async (t) => {
  const { repo } = withStateHome(t);
  const jobs = [
    {
      id: "task-p1",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 111,
      cwd: repo,
      workspaceRoot: repo,
      logPath: path.join(repo, "p1.log"),
      createdAt: new Date().toISOString()
    },
    {
      id: "task-p2",
      kind: "task",
      status: "running",
      phase: "tool",
      pid: 222,
      cwd: repo,
      workspaceRoot: repo,
      logPath: path.join(repo, "p2.log"),
      createdAt: new Date().toISOString()
    }
  ];
  for (const job of jobs) {
    fs.writeFileSync(job.logPath, "", "utf8");
    writeJobFile(repo, job.id, job);
  }
  saveState(repo, { config: {}, jobs });

  const started = [];
  const results = await cancelTrackedJobsParallel(repo, jobs, {
    budgetMs: 30_000,
    cancelImpl(job) {
      started.push(job.id);
      assert.equal(readJobFile(resolveJobFile(repo, job.id)).phase, "cancel-requested");
      return {
        job: { ...job, status: "cancelled", phase: "session-ended", pid: null },
        previousStatus: "running",
        status: "cancelled",
        delivered: true,
        method: "test",
        errorMessage: null
      };
    }
  });
  assert.deepEqual(started.sort(), ["task-p1", "task-p2"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === "cancelled"));
});

test("cancelTrackedJobsParallel leaves cancel-requested when budget is already exhausted", async (t) => {
  const { repo } = withStateHome(t);
  const job = {
    id: "task-budget",
    kind: "task",
    status: "running",
    phase: "tool",
    pid: 333,
    cwd: repo,
    workspaceRoot: repo,
    logPath: path.join(repo, "budget.log"),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(job.logPath, "", "utf8");
  writeJobFile(repo, job.id, job);
  saveState(repo, { config: {}, jobs: [job] });

  let cancelCalls = 0;
  const results = await cancelTrackedJobsParallel(repo, [job], {
    budgetMs: 0,
    cancelImpl() {
      cancelCalls += 1;
      return { status: "cancelled" };
    }
  });
  assert.equal(cancelCalls, 0);
  assert.equal(results[0].status, "cancel-requested");
  assert.equal(readJobFile(resolveJobFile(repo, job.id)).phase, "cancel-requested");
});

test("reconcileOrphanedJob is a no-op when the process is still alive", (t) => {
  const { repo } = withStateHome(t);
  const job = {
    id: "task-alive",
    kind: "task",
    status: "running",
    phase: "tool",
    pid: 1,
    processName: "node",
    processStartedAtMs: 12_345,
    cwd: repo,
    workspaceRoot: repo,
    updatedAt: "2026-07-29T10:00:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  saveState(repo, { config: {}, jobs: [job] });
  let observedOptions = null;
  const result = reconcileOrphanedJob(repo, job, {
    isProcessAliveImpl(_pid, options) {
      observedOptions = options;
      return true;
    }
  });
  assert.equal(result.status, "running");
  assert.equal(observedOptions.expectedName, "node");
  assert.equal(observedOptions.expectedStartedAtMs, 12_345);
});

test("reconcileOrphanedJob fails a pid-less queued launch after its grace period", (t) => {
  const { repo } = withStateHome(t);
  const job = {
    id: "task-spawn-missing",
    kind: "task",
    status: "queued",
    phase: "queued",
    pid: null,
    cwd: repo,
    workspaceRoot: repo,
    workerLaunchStartedAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  saveState(repo, { config: {}, jobs: [job] });
  const result = reconcileOrphanedJob(repo, job, {
    nowMs: () => Date.parse("2026-07-29T10:01:00.000Z"),
    pidlessQueueGraceMs: 1_000
  });
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "spawn-missing");
  assert.match(result.errorMessage, /process ID/);
});

test("buildStatusSnapshot treats --all and --limit as orthogonal", (t) => {
  const { repo } = withStateHome(t);
  // 12 jobs in the workspace, newest first by updatedAt.
  const jobs = [];
  for (let index = 0; index < 10; index += 1) {
    const n = String(index + 1).padStart(2, "0");
    jobs.push({
      id: `task-a-${n}`,
      kind: "task",
      status: "completed",
      phase: "completed",
      summary: `session a job ${n}`,
      updatedAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`
    });
  }
  jobs.push(
    {
      id: "task-b-01",
      kind: "task",
      status: "completed",
      phase: "completed",
      summary: "session b job 01",
      updatedAt: "2026-07-30T11:00:00.000Z"
    },
    {
      id: "task-b-02",
      kind: "task",
      status: "completed",
      phase: "completed",
      summary: "session b job 02",
      updatedAt: "2026-07-30T11:01:00.000Z"
    }
  );
  seedJobs(repo, jobs);
  // Neither: workspace jobs with the default cap of 8.
  const neither = buildStatusSnapshot(repo);
  assert.equal(neither.jobs.length, 8);
  assert.equal(neither.filters.all, false);
  assert.equal(neither.filters.limit, 8);
  assert.deepEqual(neither.jobs.slice(0, 2).map((job) => job.id), ["task-b-02", "task-b-01"]);

  // --limit alone: workspace jobs with an explicit cap.
  const limitOnly = buildStatusSnapshot(repo, { maxJobs: 2 });
  assert.equal(limitOnly.jobs.length, 2);
  assert.equal(limitOnly.filters.all, false);
  assert.equal(limitOnly.filters.limit, 2);
  assert.deepEqual(limitOnly.jobs.map((job) => job.id), ["task-b-02", "task-b-01"]);

  // --all alone: no default cap.
  const allOnly = buildStatusSnapshot(repo, { all: true });
  assert.equal(allOnly.jobs.length, 12);
  assert.equal(allOnly.filters.all, true);
  assert.equal(allOnly.filters.limit, null);

  // --all --limit: still capped by limit.
  const both = buildStatusSnapshot(repo, { all: true, maxJobs: 2 });
  assert.equal(both.jobs.length, 2);
  assert.equal(both.filters.all, true);
  assert.equal(both.filters.limit, 2);
  // Newest in the workspace are the two session-B fixtures.
  assert.deepEqual(both.jobs.map((job) => job.id), ["task-b-02", "task-b-01"]);
});

test("progressPreview reads only the log tail for large files", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, "huge.log");
  // Early timestamped line, then a payload larger than the tail window, then recent lines.
  const body = [
    "[2026-01-01T00:00:00.000Z] buried progress that may fall outside the tail window",
    "x".repeat(PROGRESS_PREVIEW_TAIL_BYTES + 8_192),
    "[2026-01-01T00:00:01.000Z] recent step one",
    "[2026-01-01T00:00:02.000Z] recent step two",
    "[2026-01-01T00:00:03.000Z] recent step three",
    "[2026-01-01T00:00:04.000Z] recent step four",
    "[2026-01-01T00:00:05.000Z] latest progress"
  ].join("\n");
  fs.writeFileSync(logPath, body, "utf8");
  assert.ok(fs.statSync(logPath).size > PROGRESS_PREVIEW_TAIL_BYTES);

  const enriched = enrichJob({
    id: "task-preview",
    status: "running",
    phase: "tool",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath
  });
  assert.ok(enriched.progressPreview.includes("latest progress"));
  assert.ok(enriched.progressPreview.includes("recent step four"));
  assert.equal(enriched.progressPreview.length <= 4, true);
  assert.equal(enriched.progressPreview.includes("buried progress that may fall outside the tail window"), false);
});

test("non-git workspace roots canonicalize to a shared absolute path", (t) => {
  const root = tempDir();
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const viaResolved = resolveWorkspaceRoot(workspace);
  const viaRelative = resolveWorkspaceRoot(path.join(workspace, ".", "sub", ".."));
  assert.equal(viaResolved, viaRelative);
  // realpath should produce a stable absolute path (Windows casing/junctions included).
  assert.equal(path.isAbsolute(viaResolved), true);
  assert.equal(fs.existsSync(viaResolved), true);
});
