import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJsonFileAtomic } from "../plugins/grok-companion/scripts/lib/fs.mjs";
import {
  getConfig,
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  resolveStateRootInfo,
  saveState,
  setConfig,
  setStateLockTestHooks,
  updateJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-companion/scripts/lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  runTrackedJob
} from "../plugins/grok-companion/scripts/lib/tracked-jobs.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot
} from "../plugins/grok-companion/scripts/lib/job-control.mjs";
import { tempDir } from "./helpers.mjs";

function withCompanionHome(t) {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    setStateLockTestHooks(null);
    if (previous === undefined) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, stateHome };
}

test("atomic JSON writes retry transient Windows rename locks", (t) => {
  const root = tempDir();
  const target = path.join(root, "state.json");
  const delays = [];
  let attempts = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeJsonFileAtomic(target, { ready: true }, {
    renameSync(tempFile, filePath) {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("target is temporarily locked");
        error.code = attempts === 1 ? "EPERM" : "EBUSY";
        throw error;
      }
      fs.renameSync(tempFile, filePath);
    },
    sleepSync(milliseconds) {
      delays.push(milliseconds);
    }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ready: true });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});

test("atomic JSON writes rethrow after bounded retries and remove the temp file", (t) => {
  const root = tempDir();
  const target = path.join(root, "state.json");
  let attempts = 0;
  let lastError = null;
  let thrown = null;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  try {
    writeJsonFileAtomic(target, { ready: false }, {
      renameSync() {
        attempts += 1;
        lastError = new Error(`locked ${attempts}`);
        lastError.code = "EACCES";
        throw lastError;
      },
      sleepSync() {}
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(attempts, 6);
  assert.equal(thrown, lastError);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("state uses a user-level override and hashes workspace paths", (t) => {
  const root = tempDir();
  const workspace = path.join(root, "workspace");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(workspace);
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

  const dir = resolveStateDir(workspace);
  assert.ok(dir.startsWith(stateHome));
  assert.match(path.basename(dir), /^workspace-[0-9a-f]{16}$/);
  assert.deepEqual(loadState(workspace).jobs, []);
  setConfig(workspace, "retentionDays", 14);
  assert.equal(getConfig(workspace).retentionDays, 14);
});

test("state root precedence is observable", () => {
  const homeDir = path.join("C:\\", "Users", "test");
  assert.deepEqual(
    resolveStateRootInfo({
      GROK_COMPANION_HOME: "C:\\explicit",
      PLUGIN_DATA: "C:\\plugin-data",
      CODEX_HOME: "C:\\codex"
    }, homeDir),
    { path: path.resolve("C:\\explicit"), source: "GROK_COMPANION_HOME" }
  );
  assert.deepEqual(
    resolveStateRootInfo({ PLUGIN_DATA: "C:\\plugin-data", CODEX_HOME: "C:\\codex" }, homeDir),
    { path: path.resolve("C:\\plugin-data"), source: "PLUGIN_DATA" }
  );
  assert.deepEqual(
    resolveStateRootInfo({ CODEX_HOME: "C:\\codex" }, homeDir),
    {
      path: path.join(path.resolve("C:\\codex"), "state", "plugins", "grok-companion"),
      source: "CODEX_HOME"
    }
  );
});

test("upsertJob creates and updates an indexed record", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  upsertJob(root, { id: "task-one", status: "queued" });
  upsertJob(root, { id: "task-one", status: "running", pid: 123 });
  assert.equal(listJobs(root).length, 1);
  assert.equal(listJobs(root)[0].status, "running");
  assert.equal(listJobs(root)[0].pid, 123);
});

test("runTrackedJob stores a completed result and index metadata", async (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = createJobRecord({
    id: "task-complete",
    kind: "task",
    title: "Task",
    cwd: root,
    workspaceRoot: root,
    summary: "test"
  }, { env: {} });
  const logPath = createJobLogFile(root, job.id, job.title);
  const execution = await runTrackedJob(job, async () => ({
    exitCode: 0,
    durationMs: 1234,
    sessionId: "33333333-3333-4333-8333-333333333333",
    payload: { rawOutput: "done" },
    rendered: "done\n"
  }), { logPath });
  assert.equal(execution.exitCode, 0);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(root, job.id), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.result.rawOutput, "done");
  assert.equal(stored.exitCode, 0);
  assert.equal(stored.durationMs, 1234);
  assert.equal(stored.request, undefined);
  const indexed = listJobs(root)[0];
  assert.equal(indexed.sessionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(indexed.exitCode, 0);
  assert.equal(indexed.durationMs, 1234);
});

test("state pruning keeps the newest 50 jobs", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  saveState(root, {
    config: {},
    jobs: Array.from({ length: 55 }, (_value, index) => ({
      id: `task-${String(index).padStart(2, "0")}`,
      status: "completed",
      updatedAt: new Date(2026, 0, 1, 0, 0, index).toISOString()
    }))
  });
  const jobs = listJobs(root);
  assert.equal(jobs.length, 50);
  assert.equal(jobs.some((job) => job.id === "task-00"), false);
  assert.equal(jobs.some((job) => job.id === "task-54"), true);
});

test("state pruning always retains active jobs", (t) => {
  const { root } = withCompanionHome(t);
  const active = {
    id: "review-active",
    status: "running",
    phase: "running",
    updatedAt: "2020-01-01T00:00:00.000Z"
  };
  const completed = Array.from({ length: 55 }, (_value, index) => ({
    id: `task-finished-${String(index).padStart(2, "0")}`,
    status: "completed",
    phase: "completed",
    updatedAt: new Date(2026, 0, 1, 0, 0, index).toISOString()
  }));
  saveState(root, { config: {}, jobs: [active, ...completed] });
  const jobs = listJobs(root);
  assert.equal(jobs.length, 50);
  assert.equal(jobs.some((job) => job.id === active.id), true);
  assert.equal(jobs.filter((job) => job.status === "completed").length, 49);
});

test("status snapshot exposes partitions and job references accept unique prefixes", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  saveState(root, {
    config: {},
    jobs: [
      { id: "task-alpha-one", kind: "task", status: "running", phase: "tool", updatedAt: "2026-07-29T08:03:00.000Z" },
      { id: "task-alpha-two", kind: "task", status: "completed", phase: "completed", updatedAt: "2026-07-29T08:02:00.000Z" },
      { id: "review-beta-one", kind: "review", status: "failed", phase: "failed", updatedAt: "2026-07-29T08:01:00.000Z" }
    ]
  });

  const snapshot = buildStatusSnapshot(root, { all: true });
  assert.deepEqual(snapshot.running.map((job) => job.id), ["task-alpha-one"]);
  assert.equal(snapshot.latestFinished.id, "task-alpha-two");
  assert.deepEqual(snapshot.recent.map((job) => job.id), ["review-beta-one"]);
  assert.equal(snapshot.jobs.length, 3);

  assert.equal(buildSingleJobSnapshot(root, "review-b").job.id, "review-beta-one");
  assert.throws(() => buildSingleJobSnapshot(root, "task-alpha"), /ambiguous/);
});

test("buildStatusSnapshot includes all jobs in the workspace", (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  saveState(root, {
    config: {},
    jobs: [
      {
        id: "task-sess-a",
        kind: "task",
        status: "completed",
        phase: "completed",
        summary: "from session a",
        updatedAt: "2026-07-29T09:02:00.000Z"
      },
      {
        id: "task-sess-b",
        kind: "task",
        status: "completed",
        phase: "completed",
        summary: "from session b",
        updatedAt: "2026-07-29T09:01:00.000Z"
      }
    ]
  });

  const filtered = buildStatusSnapshot(root);
  assert.deepEqual(filtered.jobs.map((job) => job.id), ["task-sess-a", "task-sess-b"]);
  assert.equal(filtered.latestFinished.id, "task-sess-a");

  const all = buildStatusSnapshot(root, { all: true });
  assert.deepEqual(all.jobs.map((job) => job.id).sort(), ["task-sess-a", "task-sess-b"]);
});

test("concurrent state writers retain every job", async (t) => {
  const root = tempDir();
  const stateHome = path.join(root, "state");
  const previous = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = stateHome;
  t.after(() => {
    previous === undefined ? delete process.env.GROK_COMPANION_HOME : process.env.GROK_COMPANION_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fixture = fileURLToPath(new URL("./state-writer-fixture.mjs", import.meta.url));
  await Promise.all(
    Array.from({ length: 8 }, (_value, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, root, `parallel-${index}`], {
        env: { ...process.env, GROK_COMPANION_HOME: stateHome },
        windowsHide: true,
        stdio: "ignore"
      });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`state writer exited ${code}`)));
    }))
  );
  const ids = new Set(listJobs(root).map((job) => job.id));
  assert.equal(ids.size, 8);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(ids.has(`parallel-${index}`));
  }
});

test("withStateLock recovers a stale lock and times out on a fresh lock", (t) => {
  const { root } = withCompanionHome(t);
  const stateDir = resolveStateDir(root);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const lockFile = path.join(stateDir, ".state.lock");

  fs.writeFileSync(lockFile, "dead-holder\n999999\n0\n", "utf8");
  const staleTime = Date.now() - 60_000;
  fs.utimesSync(lockFile, new Date(staleTime / 1000), new Date(staleTime / 1000));
  setStateLockTestHooks({
    isProcessAlive: () => false,
    sleepSync() {}
  });
  upsertJob(root, { id: "after-stale-lock", status: "queued" });
  assert.equal(listJobs(root).some((job) => job.id === "after-stale-lock"), true);
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, `fresh-holder\n${process.pid}\n${Date.now()}\n`, "utf8");
  const sleeps = [];
  let virtualNow = 1_000_000;
  setStateLockTestHooks({
    lockTimeoutMs: 80,
    staleLockMs: 30_000,
    isProcessAlive: () => true,
    sleepSync(ms) {
      sleeps.push(ms);
      // Advance the virtual clock only after a wait, so the first loop still sleeps.
      virtualNow += ms;
    },
    nowMs: () => virtualNow
  });
  assert.throws(
    () => upsertJob(root, { id: "blocked-by-fresh-lock", status: "queued" }),
    /Timed out waiting for Grok companion state lock/
  );
  assert.ok(sleeps.length >= 1);
  assert.ok(sleeps.every((ms) => ms >= 20));
  // Sleep delays should grow (exponential backoff) for successive waits.
  if (sleeps.length >= 2) {
    assert.ok(sleeps[1] >= sleeps[0]);
  }
  fs.unlinkSync(lockFile);
});
test("runTrackedJob keeps cancelled status when the runner finishes or throws", async (t) => {
  const { root } = withCompanionHome(t);

  const completedJob = createJobRecord({
    id: "task-cancel-race-complete",
    kind: "task",
    title: "Task",
    cwd: root,
    workspaceRoot: root,
    summary: "cancel-vs-complete"
  }, { env: {} });
  const completedLog = createJobLogFile(root, completedJob.id, completedJob.title);
  const completedExecution = await runTrackedJob(completedJob, async () => {
    writeJobFile(root, completedJob.id, {
      ...completedJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      cancelledAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 130
    });
    return {
      exitCode: 0,
      durationMs: 10,
      payload: { rawOutput: "should-not-win" },
      rendered: "should-not-win\n"
    };
  }, { logPath: completedLog });
  assert.equal(completedExecution.exitCode, 130);
  assert.equal(completedExecution.cancelled, true);
  const completedStored = readJobFile(resolveJobFile(root, completedJob.id));
  assert.equal(completedStored.status, "cancelled");
  assert.equal(completedStored.exitCode, 130);
  assert.notEqual(completedStored.result?.rawOutput, "should-not-win");

  const failedJob = createJobRecord({
    id: "task-cancel-race-fail",
    kind: "task",
    title: "Task",
    cwd: root,
    workspaceRoot: root,
    summary: "cancel-vs-fail"
  }, { env: {} });
  const failedLog = createJobLogFile(root, failedJob.id, failedJob.title);
  const failedExecution = await runTrackedJob(failedJob, async () => {
    writeJobFile(root, failedJob.id, {
      ...failedJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      cancelledAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 130
    });
    throw new Error("boom after cancel");
  }, { logPath: failedLog });
  assert.equal(failedExecution.exitCode, 130);
  assert.equal(failedExecution.cancelled, true);
  const failedStored = readJobFile(resolveJobFile(root, failedJob.id));
  assert.equal(failedStored.status, "cancelled");
  assert.equal(failedStored.exitCode, 130);
  assert.notEqual(failedStored.errorMessage, "boom after cancel");
});

test("loadState with corrupt JSON does not prune existing job files", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-survives-corrupt-state";
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Keep me",
    status: "running",
    phase: "tool",
    cwd: root,
    workspaceRoot: root,
    summary: "important",
    createdAt: new Date().toISOString()
  });
  upsertJob(root, { id: jobId, status: "running", summary: "important" });

  const jobFile = resolveJobFile(root, jobId);
  const logPath = path.join(resolveJobsDir(root), `${jobId}.log`);
  fs.writeFileSync(logPath, "log body\n", "utf8");
  assert.equal(fs.existsSync(jobFile), true);

  fs.writeFileSync(resolveStateFile(root), "{ not valid json", "utf8");
  const recovered = loadState(root);
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(recovered.jobs.some((job) => job.id === jobId), true);

  // A subsequent index write must not wipe the real job after a corrupt read path.
  upsertJob(root, { id: "task-new-after-corrupt", status: "queued" });
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(listJobs(root).some((job) => job.id === jobId), true);
  assert.ok(fs.readdirSync(path.dirname(resolveStateFile(root))).some((name) => name.includes("state.json.corrupt")));
});

test("writeJobFile keeps process-exited when a late failed worker finalizes", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-cas-orphan";
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Orphan",
    status: "running",
    phase: "running",
    cwd: root,
    workspaceRoot: root,
    summary: "orphan",
    pid: 4242,
    createdAt: new Date().toISOString()
  });
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Orphan",
    status: "failed",
    phase: "process-exited",
    cwd: root,
    workspaceRoot: root,
    summary: "orphan",
    pid: null,
    completedAt: new Date().toISOString(),
    errorMessage: "Tracked Grok process 4242 exited before the job reached a terminal state."
  });
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Orphan",
    status: "failed",
    phase: "failed",
    cwd: root,
    workspaceRoot: root,
    summary: "orphan",
    pid: null,
    completedAt: new Date().toISOString(),
    exitCode: 1,
    errorMessage: "Grok interrupted by SIGTERM."
  });
  const stored = readJobFile(resolveJobFile(root, jobId));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "process-exited");
  assert.match(stored.errorMessage, /exited before the job reached a terminal state/);
  assert.equal(stored.exitCode, 1);
});

test("writeJobFile rejects non-terminal overwrites of cancelled jobs", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-cas-terminal";
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "CAS",
    status: "running",
    phase: "running",
    cwd: root,
    workspaceRoot: root,
    summary: "cas",
    createdAt: new Date().toISOString()
  });
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "CAS",
    status: "cancelled",
    phase: "cancelled",
    cwd: root,
    workspaceRoot: root,
    summary: "cas",
    exitCode: 130,
    cancelledAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "CAS",
    status: "running",
    phase: "tool",
    cwd: root,
    workspaceRoot: root,
    summary: "cas",
    progress: { message: "stale progress" }
  });
  const stored = readJobFile(resolveJobFile(root, jobId));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.exitCode, 130);
  assert.equal(stored.progress, undefined);

  writeJobFile(root, jobId, {
    ...stored,
    status: "completed",
    phase: "completed",
    exitCode: 0,
    result: { rawOutput: "nope" }
  });
  assert.equal(readJobFile(resolveJobFile(root, jobId)).status, "cancelled");
});

test("progress updater skips silent events and only patches active jobs", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-progress-throttle";
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Progress",
    status: "running",
    phase: "starting",
    cwd: root,
    workspaceRoot: root,
    summary: "progress",
    createdAt: new Date().toISOString()
  });
  const update = createJobProgressUpdater({ workspaceRoot: root, jobId });
  update({ eventType: "thought", suppressProgress: true, message: "thinking", phase: "thinking" });
  update({ eventType: "text", message: "token", phase: "text" });
  assert.equal(readJobFile(resolveJobFile(root, jobId)).phase, "starting");

  update({ eventType: "tool_use", message: "tool", phase: "tool", sessionId: "sess-1" });
  const afterTool = readJobFile(resolveJobFile(root, jobId));
  assert.equal(afterTool.phase, "tool");
  assert.equal(afterTool.sessionId, "sess-1");
  assert.equal(afterTool.sessionConfirmed, true);

  writeJobFile(root, jobId, {
    ...afterTool,
    status: "cancelled",
    phase: "cancelled",
    exitCode: 130,
    cancelledAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  update({ eventType: "tool_use", message: "late", phase: "tool" });
  assert.equal(readJobFile(resolveJobFile(root, jobId)).status, "cancelled");
});

test("appendLogLine swallows I/O errors without throwing", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Path under a file (not a directory) forces appendFileSync to fail.
  const blocker = path.join(root, "not-a-dir");
  fs.writeFileSync(blocker, "x", "utf8");
  assert.doesNotThrow(() => appendLogLine(path.join(blocker, "job.log"), "hello"));
});

test("readJobFile returns a corrupt marker instead of throwing on bad JSON", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-corrupt-json";
  const file = resolveJobFile(root, jobId);
  fs.writeFileSync(file, "{broken", "utf8");
  const stored = readJobFile(file);
  assert.equal(stored.corrupt, true);
  assert.equal(stored.phase, "corrupt");
  assert.match(stored.errorMessage, /corrupt/i);
});

test("updateJobFile mutator can skip when status is no longer active", (t) => {
  const { root } = withCompanionHome(t);
  const jobId = "task-update-skip";
  writeJobFile(root, jobId, {
    id: jobId,
    kind: "task",
    title: "Skip",
    status: "completed",
    phase: "completed",
    cwd: root,
    workspaceRoot: root,
    summary: "skip",
    createdAt: new Date().toISOString()
  });
  const result = updateJobFile(root, jobId, (latest) => ({
    ...latest,
    status: "running",
    phase: "tool"
  }));
  assert.equal(result.status, "completed");
  assert.equal(readJobFile(resolveJobFile(root, jobId)).status, "completed");
});
