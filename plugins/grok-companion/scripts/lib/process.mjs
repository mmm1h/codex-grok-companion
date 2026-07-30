import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const PROCESS_START_TIME_SKEW_MS = 5_000;
export const PROCESS_IDENTITY_CACHE_MS = 1_000;
const processIdentityCache = new Map();

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments
  });
  return {
    command,
    args,
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

const timeoutKillWaiter = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(timeoutKillWaiter, 0, 0, milliseconds);
  }
}

/**
 * Like runCommand, but on timeout terminates the whole process tree.
 *
 * Node's spawnSync timeout only kills the direct child. On Windows that leaves
 * grandchildren (e.g. the real Grok worker under grok-companion) orphaned and
 * holding cwd / temp handles — a known source of EPERM during cleanup.
 */
export function runCommandWithTimeout(command, args = [], options = {}) {
  const timeoutMs = options.timeout;
  if (timeoutMs == null) {
    return Promise.resolve(runCommand(command, args, options));
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  const spawnImpl = options.spawnImpl ?? spawn;
  const terminateImpl = options.terminateImpl ?? terminateProcessTree;
  const platform = options.platform ?? process.platform;
  const input = options.input;
  // Windows keeps directory handles briefly after taskkill; keep this short so
  // fail-closed hooks still return promptly.
  const settleMs = options.settleMs ?? (platform === "win32" ? 50 : 0);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timer = null;
    let forceTimer = null;
    const recordedChildPids = Array.isArray(options.childPids) ? [...options.childPids] : [];

    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: options.shell ?? false,
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      stdio: input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    });

    const killTree = () => {
      const pid = child.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        return;
      }
      try {
        terminateImpl(pid, {
          platform,
          cwd,
          env,
          childPids: recordedChildPids
        });
      } catch {
        // Prefer reporting the timeout over a secondary kill failure.
      }
    };

    const finish = ({ status = null, signal = null, error = null } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      let finalError = error;
      if (timedOut && !finalError) {
        finalError = Object.assign(new Error(`Command timed out after ${timeoutMs} ms: ${command}`), {
          code: "ETIMEDOUT",
          errno: "ETIMEDOUT",
          syscall: "spawn",
          spawnargs: args
        });
      }
      // Settle synchronously so short-lived hooks always emit their decision
      // before process exit (unref'd timers can drop the promise resolution).
      if (timedOut && settleMs > 0) {
        sleepSyncMs(settleMs);
      }
      resolve({
        command,
        args,
        pid: Number.isInteger(child.pid) ? child.pid : null,
        status: timedOut ? null : status,
        signal: timedOut ? null : signal,
        stdout,
        stderr,
        error: finalError,
        timedOut
      });
    };

    const append = (kind, chunk) => {
      if (settled) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxBuffer) {
        killTree();
        finish({
          error: Object.assign(new Error("stdout maxBuffer exceeded"), {
            code: "ENOBUFS"
          })
        });
        return;
      }
      if (kind === "stdout") {
        stdout += chunk.toString();
      } else {
        stderr += chunk.toString();
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));

    if (input != null) {
      child.stdin?.write(String(input));
      child.stdin?.end();
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
        // If the tree refuses to die, still unblock the caller.
        forceTimer = setTimeout(() => {
          killTree();
          finish();
        }, 2_000);
        forceTimer.unref?.();
      }, timeoutMs);
      // Keep the timeout timer referenced so short-lived scripts cannot exit
      // before the kill + fail-closed decision path runs.
    }

    child.once("error", (error) => {
      finish({ error, status: 1 });
    });
    child.once("close", (code, signal) => {
      finish({ status: code ?? (timedOut ? null : 1), signal });
    });
  });
}

export function formatCommandFailure(result) {
  const command = [result.command, ...result.args].join(" ");
  const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
  return `${command}: ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}${detail ? `: ${detail}` : ""}`;
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

/**
 * Resolve a command to a concrete executable path on Windows.
 * Prefers .exe over .cmd/.bat so spawn({ shell: false }) can start without a shell.
 * Returns the original command on non-Windows or when resolution fails.
 */
export function resolveExecutable(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const raw = String(command ?? "").trim();
  if (!raw || platform !== "win32") {
    return raw;
  }
  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return raw;
  }

  const run = options.runCommandImpl ?? runCommand;
  const env = options.env ?? process.env;
  const where = run("where.exe", [raw], {
    cwd: options.cwd,
    env,
    shell: false
  });
  if (!where.error && where.status === 0) {
    const candidates = String(where.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const preferred =
      candidates.find((line) => /\.exe$/i.test(line))
      ?? candidates.find((line) => /\.cmd$/i.test(line))
      ?? candidates.find((line) => /\.bat$/i.test(line))
      ?? candidates[0];
    if (preferred) {
      return preferred;
    }
  }

  // Manual PATH + PATHEXT probe when where.exe is unavailable.
  const pathExt = String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const extensions = pathExt.length > 0 ? pathExt : [".EXE", ".CMD", ".BAT", ".COM"];
  const hasExt = /\.[^./\\]+$/.test(raw);
  const names = hasExt ? [raw] : [raw, ...extensions.map((ext) => `${raw}${ext}`)];
  // Prefer .exe when we synthesize names without an extension.
  names.sort((left, right) => Number(/\.exe$/i.test(right)) - Number(/\.exe$/i.test(left)));
  const pathEntries = String(env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore unreadable path entries.
      }
    }
  }
  return raw;
}

function resolveWindowsNpmShim(shimPath) {
  let contents;
  try {
    contents = fs.readFileSync(shimPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read Windows command shim "${shimPath}": ${detail}`);
  }
  const matches = [...contents.matchAll(/"(%dp0%\\[^"\r\n]+\.(?:exe|[cm]?js))"\s+%\*/gi)];
  const rawTarget = matches.at(-1)?.[1] ?? null;
  if (!rawTarget) {
    throw new Error(
      `Refusing to execute unsupported Windows command shim "${shimPath}". `
      + "Install a native Grok executable or a standard npm-generated shim."
    );
  }
  const shimDir = path.dirname(shimPath);
  const relativeTarget = rawTarget.replace(/^%dp0%\\/i, "");
  const target = path.resolve(shimDir, relativeTarget);
  if (!fs.existsSync(target)) {
    throw new Error(`Windows command shim target does not exist: "${target}".`);
  }
  if (/\.exe$/i.test(target)) {
    return { command: target, prefixArgs: [] };
  }
  return { command: process.execPath, prefixArgs: [target] };
}

/**
 * Build a spawn-safe command/args pair for Windows npm shims and normal binaries.
 * Batch files are never passed to cmd.exe with user-controlled arguments.
 */
export function resolveSpawnInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutable(command, options);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const shim = resolveWindowsNpmShim(resolved);
    return {
      command: shim.command,
      args: [...shim.prefixArgs, ...args],
      shell: false,
      windowsVerbatimArguments: false,
      resolved
    };
  }
  return {
    command: resolved,
    args: [...args],
    shell: false,
    windowsVerbatimArguments: false,
    resolved
  };
}

/**
 * Start a detached process only after Node confirms that OS process creation
 * succeeded. Spawn errors reject instead of becoming unhandled events.
 */
export function spawnDetachedProcess(command, args = [], options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const {
    spawnImpl: _spawnImpl,
    ...spawnOptions
  } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        ...spawnOptions,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        reject(new Error("Detached process started without a valid PID."));
        return;
      }
      child.unref();
      resolve(child);
    });
  });
}

/** @deprecated Prefer resolveSpawnInvocation; kept for call sites that only need the path. */
export function spawnCommandOptions(command, options = {}) {
  const invocation = resolveSpawnInvocation(command, [], options);
  return {
    command: invocation.resolved,
    shell: false,
    resolved: invocation.resolved
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const invocation = resolveSpawnInvocation(command, versionArgs, options);
  const run = options.runCommandImpl ?? runCommand;
  const result = run(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found", command: invocation.resolved };
  }
  if (result.error || result.status !== 0) {
    return {
      available: false,
      detail: result.error?.message ?? String(result.stderr || result.stdout || `exit ${result.status}`).trim(),
      command: invocation.resolved
    };
  }
  return { available: true, detail: String(result.stdout || result.stderr || "ok").trim(), command: invocation.resolved };
}

function missingProcess(text) {
  // Include localized Windows taskkill messages (e.g. 找不到 / 没有找到).
  return /not found|no running instance|cannot find|does not exist|no such process|找不到|没有找到|无法找到/i.test(text);
}

function taskkillPartialFailure(text) {
  // taskkill /T can return non-zero when some children refuse (access denied,
  // "operation not supported") even after the target tree is mostly dead.
  return /access is denied|操作不支持|拒绝访问|could not be terminated|无法终止/i.test(text);
}

function parseWindowsDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const serialized = raw.match(/^\\?\/Date\((\d+)(?:[+-]\d+)?\)\\?\/$/);
  if (serialized) {
    const milliseconds = Number(serialized[1]);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Best-effort process identity for PID-reuse guards.
 * Returns null when the process is gone or identity cannot be read.
 */
function readProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;

  if (platform === "win32") {
    const ps = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 -Property ProcessName,StartTime | ConvertTo-Json -Compress`
      ],
      { cwd: options.cwd, env: options.env, shell: false }
    );
    if (!ps.error && ps.status === 0 && ps.stdout.trim()) {
      try {
        const data = JSON.parse(ps.stdout);
        const name = data?.ProcessName ? String(data.ProcessName) : null;
        const startedAtMs = parseWindowsDate(data?.StartTime);
        if (name || startedAtMs != null) {
          return { pid, name, startedAtMs };
        }
      } catch {
        // Fall through to wmic.
      }
    }
    const wmic = run(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "Name,CreationDate", "/format:csv"],
      { cwd: options.cwd, env: options.env, shell: false }
    );
    if (!wmic.error && wmic.status === 0) {
      const lines = String(wmic.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // CSV: Node,CreationDate,Name
      for (const line of lines.slice(1)) {
        const parts = line.split(",");
        if (parts.length < 3) {
          continue;
        }
        const creation = parts[parts.length - 2] ?? "";
        const name = (parts[parts.length - 1] ?? "").replace(/\.exe$/i, "");
        // WMIC CreationDate like 20260729123045.123456+480
        const match = creation.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
        let startedAtMs = null;
        if (match) {
          startedAtMs = Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6])
          );
        }
        if (name || startedAtMs != null) {
          return { pid, name: name || null, startedAtMs };
        }
      }
    }
    return null;
  }

  // POSIX: prefer /proc, fall back to ps.
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    let startedAtMs = null;
    try {
      const procStat = fs.statSync(`/proc/${pid}`);
      startedAtMs = procStat.birthtimeMs || procStat.ctimeMs || null;
    } catch {
      // ignore
    }
    if (comm) {
      return { pid, name: comm, startedAtMs };
    }
  } catch {
    // /proc unavailable (macOS etc.)
  }

  const ps = run("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
    cwd: options.cwd,
    env: {
      ...(options.env ?? process.env),
      LC_ALL: "C",
      LANG: "C"
    },
    shell: false
  });
  if (!ps.error && ps.status === 0 && ps.stdout.trim()) {
    const line = ps.stdout.trim();
    // lstart is like "Mon Jul 29 12:30:45 2026" then comm
    const match = line.match(/^([A-Z][a-z]{2}\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    if (match) {
      return {
        pid,
        name: match[2].trim().split(/[\\/]/).pop() ?? match[2].trim(),
        startedAtMs: Date.parse(match[1])
      };
    }
    return { pid, name: line.split(/\s+/).pop() ?? null, startedAtMs: null };
  }
  return null;
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const cacheMs = options.identityCacheMs
    ?? (options.runCommandImpl ? 0 : PROCESS_IDENTITY_CACHE_MS);
  const cacheKey = `${options.platform ?? process.platform}:${pid}`;
  const now = Date.now();
  const cached = processIdentityCache.get(cacheKey);
  if (cacheMs > 0 && cached && now - cached.at <= cacheMs) {
    return cached.identity;
  }
  const identity = readProcessIdentity(pid, options);
  if (cacheMs > 0 && identity) {
    processIdentityCache.set(cacheKey, { at: now, identity });
  }
  return identity;
}

function normalizeProcessName(name) {
  return String(name ?? "")
    .trim()
    .replace(/\.exe$/i, "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
}

/**
 * Optional identity match for PID-reuse safety.
 * When no expected* fields are provided, always matches (backward compatible).
 */
export function processIdentityMatches(identity, options = {}) {
  if (!options.expectedName && options.expectedStartedAt == null && options.expectedStartedAtMs == null) {
    return true;
  }
  if (!identity) {
    return false;
  }
  if (options.expectedName) {
    const expected = normalizeProcessName(options.expectedName);
    const actual = normalizeProcessName(identity.name);
    if (!actual || actual !== expected) {
      return false;
    }
  }
  const expectedMs = options.expectedStartedAtMs
    ?? (options.expectedStartedAt != null ? Date.parse(String(options.expectedStartedAt)) : null);
  if (expectedMs != null && Number.isFinite(expectedMs)) {
    if (identity.startedAtMs == null || !Number.isFinite(identity.startedAtMs)) {
      return false;
    }
    // Allow skew between job bookkeeping and OS process start.
    const skewMs = options.startTimeSkewMs ?? PROCESS_START_TIME_SKEW_MS;
    if (Math.abs(identity.startedAtMs - expectedMs) > skewMs) {
      return false;
    }
  }
  return true;
}

function signalAlive(pid, kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const kill = options.killImpl ?? process.kill.bind(process);
  if (!signalAlive(pid, kill)) {
    return false;
  }
  // Backward compatible: no identity expectations → alive if kill(pid,0) succeeds.
  if (!options.expectedName && options.expectedStartedAt == null && options.expectedStartedAtMs == null) {
    return true;
  }
  const identity = typeof options.getIdentityImpl === "function"
    ? options.getIdentityImpl(pid, options)
    : getProcessIdentity(pid, options);
  return processIdentityMatches(identity, options);
}

function collectDescendantPids(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  // Windows uses taskkill /T for tree kill; PowerShell CIM walks are too slow for
  // the hot timeout path (must stay well under a second under concurrent load).
  if (platform === "win32") {
    return [];
  }
  const run = options.runCommandImpl ?? runCommand;
  const seen = new Set();
  const queue = [pid];
  const descendants = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const result = run("pgrep", ["-P", String(current)], {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const child = Number(line.trim());
      if (!Number.isInteger(child) || child <= 0 || seen.has(child) || child === pid) {
        continue;
      }
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function tryKill(kill, pid, signal) {
  try {
    kill(pid, signal);
    return { ok: true, code: null };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, error };
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;
  const kill = options.killImpl ?? process.kill.bind(process);

  // PID-reuse guard: refuse to signal a process that no longer matches expectations.
  if (options.expectedName || options.expectedStartedAt != null || options.expectedStartedAtMs != null) {
    const identity = typeof options.getIdentityImpl === "function"
      ? options.getIdentityImpl(pid, options)
      : getProcessIdentity(pid, { ...options, identityCacheMs: 0 });
    if (!processIdentityMatches(identity, options)) {
      return { attempted: true, delivered: false, method: "identity-mismatch", identity };
    }
  }

  // Explicit child PIDs (e.g. recorded Grok worker children) are always targeted.
  const extraChildren = Array.isArray(options.childPids)
    ? options.childPids.filter((value) => Number.isInteger(value) && value > 0 && value !== pid)
    : [];
  const descendants = platform === "win32"
    ? []
    : collectDescendantPids(pid, { ...options, runCommandImpl: run });
  const tree = [...new Set([...extraChildren, ...descendants])];

  if (platform === "win32") {
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    if (result.error?.code === "ENOENT") {
      // taskkill missing — fall through to direct kill below.
    } else if (result.error) {
      throw result.error;
    } else {
      const combined = `${result.stdout}\n${result.stderr}`;
      let delivered = result.status === 0;
      // Partial tree failures still count as a delivered kill attempt when the
      // parent is gone or taskkill reported a known soft failure. Callers that
      // need certainty also check isProcessAlive.
      if (!delivered && !missingProcess(combined) && taskkillPartialFailure(combined)) {
        delivered = !signalAlive(pid, kill);
      } else if (!delivered && missingProcess(combined)) {
        delivered = false;
      } else if (!delivered && result.status !== 0) {
        // Unknown non-zero: still treat as attempted; delivered if parent died.
        delivered = !signalAlive(pid, kill);
      }

      let childDelivered = false;
      for (const target of extraChildren) {
        const childKill = run("taskkill", ["/PID", String(target), "/T", "/F"], {
          cwd: options.cwd,
          env: options.env
        });
        if (!childKill.error && childKill.status === 0) {
          childDelivered = true;
        } else if (!childKill.error && !missingProcess(`${childKill.stdout}\n${childKill.stderr}`)) {
          if (!signalAlive(target, kill)) {
            childDelivered = true;
          }
        }
      }

      return {
        attempted: true,
        delivered: delivered || childDelivered,
        method: childDelivered ? "taskkill+children" : "taskkill",
        result
      };
    }
  }

  const targets = platform === "win32" ? [pid, ...extraChildren] : [pid, ...tree];
  const settleMs = options.settleMs ?? (platform === "win32" ? 0 : 50);
  const sleep = options.sleepImpl ?? sleepSyncMs;

  const signalTargets = (signal, { preferGroup }) => {
    let delivered = false;
    let method = null;

    if (preferGroup && platform !== "win32") {
      // Prefer process-group signal so a detached/session-leader worker and its
      // Grok child die together.
      const group = tryKill(kill, -pid, signal);
      if (group.ok) {
        delivered = true;
        method = "process-group";
        for (const child of tree) {
          const childKill = tryKill(kill, child, signal);
          if (childKill.ok) {
            method = "process-group+tree";
          } else if (childKill.code && childKill.code !== "ESRCH") {
            throw childKill.error;
          }
        }
        return { delivered, method };
      }
      if (group.code && group.code !== "ESRCH" && group.code !== "EPERM") {
        // Unexpected group-kill failure: still try direct targets below.
      }
    }

    for (const target of targets) {
      const result = tryKill(kill, target, signal);
      if (result.ok) {
        delivered = true;
        if (!method) {
          method = target === pid ? "process" : "process-tree";
        } else if (method === "process" && target !== pid) {
          method = "process+tree";
        }
        continue;
      }
      if (result.code === "ESRCH") {
        continue;
      }
      if (result.code === "EPERM") {
        delivered = true;
        method = method ?? (target === pid ? "process" : "process-tree");
        continue;
      }
      throw result.error;
    }

    return { delivered, method: method ?? (delivered ? "process" : null) };
  };

  const first = signalTargets("SIGTERM", { preferGroup: true });
  const anyTargetAlive = () => {
    const seen = new Set();
    for (const target of [pid, ...targets]) {
      if (!Number.isInteger(target) || target <= 0 || seen.has(target)) {
        continue;
      }
      seen.add(target);
      if (signalAlive(target, kill)) {
        return true;
      }
    }
    return false;
  };
  // Give a brief settle, then escalate so workers cannot finalize after SIGTERM
  // and race orphan reconciliation into a plain failed phase.
  if (first.delivered && settleMs >= 0) {
    if (settleMs > 0) {
      sleep(settleMs);
    }
    if (anyTargetAlive()) {
      const second = signalTargets("SIGKILL", { preferGroup: true });
      return {
        attempted: true,
        delivered: first.delivered || second.delivered,
        method: second.method
          ? `${first.method ?? "process"}+sigkill`
          : (first.method ?? "process")
      };
    }
  }

  return {
    attempted: true,
    delivered: first.delivered,
    method: first.method ?? "process"
  };
}
