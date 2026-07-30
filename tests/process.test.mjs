import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cancelTrackedJob } from "../plugins/grok-companion/scripts/lib/job-control.mjs";
import {
  binaryAvailable,
  getProcessIdentity,
  isProcessAlive,
  processIdentityMatches,
  resolveExecutable,
  resolveSpawnInvocation,
  runCommandWithTimeout,
  spawnDetachedProcess,
  terminateProcessTree
} from "../plugins/grok-companion/scripts/lib/process.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok-companion/scripts/lib/state.mjs";
import { initRepo, removeTempDir, tempDir } from "./helpers.mjs";

test("POSIX termination falls back from a missing process group to the process", () => {
  const calls = [];
  const alive = new Set([1234]);
  const result = terminateProcessTree(1234, {
    platform: "linux",
    settleMs: 0,
    runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }),
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no process group");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === 0) {
        if (!alive.has(pid)) {
          const error = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      if (signal === "SIGKILL") {
        alive.delete(pid);
      }
    }
  });
  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"],
    [1234, 0],
    [-1234, "SIGKILL"],
    [1234, "SIGKILL"]
  ]);
  assert.equal(result.delivered, true);
  assert.equal(result.method, "process+sigkill");
});

test("termination reports an already exited process without throwing", () => {
  const result = terminateProcessTree(1234, {
    platform: "linux",
    runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }),
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(result.attempted, true);
  assert.equal(result.delivered, false);
});

test("Windows taskkill termination reports success, missing process, and ENOENT fallback", () => {
  const success = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl(command, args) {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/PID", "4242", "/T", "/F"]);
      return { status: 0, stdout: "SUCCESS: The process with PID 4242 has been terminated.", stderr: "", error: null };
    }
  });
  assert.equal(success.method, "taskkill");
  assert.equal(success.delivered, true);
  assert.equal(success.attempted, true);

  const missing = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl: () => ({
      status: 128,
      stdout: "",
      stderr: "ERROR: The process \"4242\" not found.",
      error: null
    })
  });
  assert.equal(missing.method, "taskkill");
  assert.equal(missing.delivered, false);
  assert.equal(missing.attempted, true);

  // Partial tree failures (access denied / 操作不支持) must not throw when the
  // parent is already gone — cancel paths rely on a soft delivered result.
  const partial = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl: () => ({
      status: 128,
      stdout: "",
      stderr: "ERROR: The process with PID 9001 (child process of PID 4242) could not be terminated.\nReason: Access is denied.\n",
      error: null
    }),
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(partial.attempted, true);
  assert.equal(partial.delivered, true);
  assert.equal(partial.method, "taskkill");

  // Explicit childPids are taskkilled even when the parent tree kill succeeds.
  const childCalls = [];
  const withChild = terminateProcessTree(4242, {
    platform: "win32",
    childPids: [9001],
    runCommandImpl(command, args) {
      childCalls.push([command, ...args]);
      return { status: 0, stdout: "SUCCESS", stderr: "", error: null };
    }
  });
  assert.equal(withChild.delivered, true);
  assert.equal(withChild.method, "taskkill+children");
  assert.ok(childCalls.some((entry) => entry[0] === "taskkill" && entry.includes("9001")));

  const calls = [];
  const alive = new Set([4242]);
  const enoent = terminateProcessTree(4242, {
    platform: "win32",
    settleMs: 0,
    runCommandImpl: () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      return { status: 1, stdout: "", stderr: "", error };
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (signal === 0) {
        if (!alive.has(pid)) {
          const error = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      if (signal === "SIGKILL") {
        alive.delete(pid);
      }
    }
  });
  assert.deepEqual(calls, [[4242, "SIGTERM"], [4242, 0], [4242, "SIGKILL"]]);
  assert.equal(enoent.method, "process+sigkill");
  assert.equal(enoent.delivered, true);
});

test("POSIX termination also signals recorded child PIDs and pgrep descendants", () => {
  const calls = [];
  const result = terminateProcessTree(100, {
    platform: "linux",
    settleMs: 0,
    childPids: [200],
    runCommandImpl(command, args) {
      if (command === "pgrep" && args[0] === "-P" && args[1] === "100") {
        return { status: 0, stdout: "300\n", stderr: "", error: null };
      }
      return { status: 1, stdout: "", stderr: "", error: null };
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no group");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === 0) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  assert.equal(result.delivered, true);
  assert.ok(calls.some((entry) => entry[0] === 100 && entry[1] === "SIGTERM"));
  assert.ok(calls.some((entry) => entry[0] === 200 && entry[1] === "SIGTERM"));
  assert.ok(calls.some((entry) => entry[0] === 300 && entry[1] === "SIGTERM"));
  assert.match(result.method, /tree|process/);
});

test("isProcessAlive accepts optional identity guards without changing default behavior", () => {
  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      }
    }),
    true
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedName: "node",
      getIdentityImpl: () => ({ pid: 1, name: "node", startedAtMs: 1_000 })
    }),
    true
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedName: "node",
      getIdentityImpl: () => ({ pid: 1, name: "chrome", startedAtMs: 1_000 })
    }),
    false
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedStartedAtMs: 1_000,
      getIdentityImpl: () => ({ pid: 1, name: "node", startedAtMs: 999_999_999 })
    }),
    false
  );

  assert.equal(
    processIdentityMatches(
      { pid: 9, name: "grok", startedAtMs: 5_000 },
      { expectedName: "grok.exe", expectedStartedAtMs: 5_100 }
    ),
    true
  );
});

test("getProcessIdentity parses Windows PowerShell serialized start times", () => {
  const identity = getProcessIdentity(42, {
    platform: "win32",
    runCommandImpl(command) {
      if (command === "powershell.exe") {
        return {
          status: 0,
          stdout: '{"ProcessName":"node","StartTime":"\\\\/Date(1785384559924)\\\\/"}',
          stderr: "",
          error: null
        };
      }
      return { status: 1, stdout: "", stderr: "", error: null };
    }
  });
  assert.deepEqual(identity, {
    pid: 42,
    name: "node",
    startedAtMs: 1_785_384_559_924
  });
});

test("getProcessIdentity caches probes and forces a stable POSIX locale", () => {
  let windowsCalls = 0;
  const options = {
    platform: "win32",
    identityCacheMs: 10_000,
    runCommandImpl(command) {
      windowsCalls += 1;
      assert.equal(command, "powershell.exe");
      return {
        status: 0,
        stdout: '{"ProcessName":"node","StartTime":"\\\\/Date(1785384559924)\\\\/"}',
        stderr: "",
        error: null
      };
    }
  };
  assert.deepEqual(getProcessIdentity(919_191, options), getProcessIdentity(919_191, options));
  assert.equal(windowsCalls, 1);

  let observedEnv = null;
  const posix = getProcessIdentity(919_192, {
    platform: "darwin",
    runCommandImpl(command, _args, runOptions) {
      assert.equal(command, "ps");
      observedEnv = runOptions.env;
      return {
        status: 0,
        stdout: "Mon Jul 29 12:30:45 2026 node\n",
        stderr: "",
        error: null
      };
    }
  });
  assert.equal(posix.name, "node");
  assert.equal(observedEnv.LC_ALL, "C");
  assert.equal(observedEnv.LANG, "C");
});

test("terminateProcessTree refuses to kill a PID that fails identity checks", () => {
  const calls = [];
  const result = terminateProcessTree(55, {
    platform: "linux",
    expectedName: "node",
    getIdentityImpl: () => ({ pid: 55, name: "unrelated", startedAtMs: 1 }),
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });
  assert.equal(result.delivered, false);
  assert.equal(result.method, "identity-mismatch");
  assert.deepEqual(calls, []);
});

test("Windows executable resolution prefers .exe and bypasses standard npm .cmd shims", (t) => {
  const exe = resolveExecutable("grok", {
    platform: "win32",
    runCommandImpl: () => ({
      status: 0,
      stdout: "C:\\npm\\grok.cmd\nC:\\tools\\grok.exe\n",
      stderr: "",
      error: null
    })
  });
  assert.equal(exe, "C:\\tools\\grok.exe");

  const cmdOnly = resolveExecutable("grok", {
    platform: "win32",
    runCommandImpl: () => ({
      status: 0,
      stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd\n",
      stderr: "",
      error: null
    })
  });
  assert.equal(cmdOnly, "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd");

  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, "grok.cmd");
  const target = path.join(root, "grok-target.mjs");
  fs.writeFileSync(
    shim,
    '@ECHO off\r\n"%dp0%\\grok-target.mjs" %*\r\n',
    "utf8"
  );
  fs.writeFileSync(target, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");

  const prompt = "hello & echo %PATH% | <unsafe> ^!";
  const invocation = resolveSpawnInvocation(
    "grok",
    ["-p", prompt],
    {
      platform: "win32",
      runCommandImpl: () => ({
        status: 0,
        stdout: `${shim}\n`,
        stderr: "",
        error: null
      })
    }
  );
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsVerbatimArguments, false);
  assert.deepEqual(invocation.args, [target, "-p", prompt]);
  const observed = spawnSync(invocation.command, invocation.args, { encoding: "utf8", shell: false });
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout), ["-p", prompt]);

  const unsupported = path.join(root, "unsupported.cmd");
  fs.writeFileSync(unsupported, "@echo off\r\necho %*\r\n", "utf8");
  assert.throws(
    () => resolveSpawnInvocation(unsupported, [prompt], { platform: "win32" }),
    /Refusing to execute unsupported Windows command shim/
  );

  const linux = resolveSpawnInvocation("grok", ["--version"], { platform: "linux" });
  assert.equal(linux.command, "grok");
  assert.deepEqual(linux.args, ["--version"]);
  assert.equal(linux.shell, false);
});

test("spawnDetachedProcess rejects an asynchronous spawn error", async () => {
  const child = new EventEmitter();
  child.pid = undefined;
  child.unref = () => {};
  const pending = spawnDetachedProcess("missing", [], {
    spawnImpl() {
      process.nextTick(() => {
        const error = new Error("blocked by policy");
        error.code = "EACCES";
        child.emit("error", error);
      });
      return child;
    }
  });
  await assert.rejects(pending, /blocked by policy/);
});

test("binaryAvailable uses resolved Windows path without requiring shell:true", () => {
  const calls = [];
  const result = binaryAvailable("grok", ["--version"], {
    platform: "win32",
    runCommandImpl(command, args, options = {}) {
      calls.push({ command, args, shell: options.shell ?? false });
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: "C:\\tools\\grok.exe\n",
          stderr: "",
          error: null
        };
      }
      return {
        status: 0,
        stdout: "grok 0.2.114\n",
        stderr: "",
        error: null
      };
    }
  });
  assert.equal(result.available, true);
  assert.equal(result.command, "C:\\tools\\grok.exe");
  assert.ok(calls.some((call) => call.command === "C:\\tools\\grok.exe" && call.shell === false));
});

test("runCommandWithTimeout reaps nested children so Windows temp dirs unlock", async (t) => {
  const root = tempDir();
  const holder = path.join(root, "tree-holder.mjs");
  // Parent keeps the temp cwd open and spawns a long-lived grandchild. A bare
  // spawnSync timeout would kill only the parent and leave the grandchild
  // locking the directory (EPERM on rmSync) during timeout cleanup.
  fs.writeFileSync(
    holder,
    `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true
});
process.stdout.write(String(child.pid) + "\\n");
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  t.after(() => {
    try {
      removeTempDir(root);
    } catch {
      // The assertion below is the contract; best-effort cleanup if it failed.
    }
  });

  const result = await runCommandWithTimeout(process.execPath, [holder], {
    cwd: root,
    timeout: 400,
    settleMs: process.platform === "win32" ? 300 : 0
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.error?.code, "ETIMEDOUT");
  const grandchildPid = Number(String(result.stdout).trim().split(/\r?\n/)[0]);
  if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
    assert.equal(isProcessAlive(grandchildPid), false, `grandchild ${grandchildPid} should be reaped`);
  }
  removeTempDir(root);
  assert.equal(fs.existsSync(root), false);
});

test("cancel helper does not report cancelled when termination is not delivered", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const previousHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = path.join(root, "state");
  t.after(() => {
    if (previousHome == null) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previousHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = {
    id: "task-cancel-failed",
    kind: "task",
    title: "Task",
    status: "running",
    phase: "running",
    pid: 1234,
    processName: "node",
    processStartedAtMs: 12_345,
    cwd: repo,
    workspaceRoot: repo,
    summary: "test",
    createdAt: new Date().toISOString()
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  let terminateOptions = null;
  let aliveOptions = null;
  const result = cancelTrackedJob(repo, job, {
    terminateImpl(_pid, options) {
      terminateOptions = options;
      return { attempted: true, delivered: false, method: "test-signal" };
    },
    isProcessAliveImpl(_pid, options) {
      aliveOptions = options;
      return true;
    }
  });
  const stored = readJobFile(resolveJobFile(repo, job.id));
  assert.equal(result.status, "cancel-failed");
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "cancel-failed");
  assert.equal(stored.terminationDelivered, false);
  assert.equal(stored.terminationMethod, "test-signal");
  assert.ok(stored.cancelRequestedAt);
  assert.match(stored.errorMessage, /still running/);
  assert.equal(terminateOptions.expectedName, "node");
  assert.equal(terminateOptions.expectedStartedAtMs, 12_345);
  assert.equal(aliveOptions.expectedName, "node");

  const goneJob = { ...job, id: "task-already-exited", pid: 5678 };
  writeJobFile(repo, goneJob.id, goneJob);
  upsertJob(repo, goneJob);
  const gone = cancelTrackedJob(repo, goneJob, {
    terminateImpl: () => ({ attempted: true, delivered: false, method: null }),
    isProcessAliveImpl: () => false
  });
  const goneStored = readJobFile(resolveJobFile(repo, goneJob.id));
  assert.equal(gone.status, "cancelled");
  assert.equal(gone.delivered, false);
  assert.equal(goneStored.terminationMethod, "already-exited");
  assert.ok(goneStored.cancelledAt);

  const queued = {
    ...job,
    id: "task-before-pid",
    status: "queued",
    phase: "queued",
    pid: null,
    processName: null,
    processStartedAtMs: null
  };
  writeJobFile(repo, queued.id, queued);
  upsertJob(repo, queued);
  const beforePid = cancelTrackedJob(repo, queued);
  assert.equal(beforePid.status, "cancelled");
  assert.equal(beforePid.delivered, false);
  assert.equal(beforePid.method, "marked-before-worker-pid");
});
