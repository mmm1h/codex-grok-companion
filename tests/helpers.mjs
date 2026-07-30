import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-companion");
export const COMPANION = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");
export const FAKE_GROK = path.join(ROOT, "tests", "fake-grok-fixture.mjs");

export function tempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const RM_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const RM_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800];
const rmWaiter = new Int32Array(new SharedArrayBuffer(4));

/**
 * Windows can keep directory handles briefly after child-tree termination
 * (and under AV scanners). Retry the same codes as atomic rename recovery.
 */
export function removeTempDir(dir) {
  if (!dir) {
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      if (!RM_RETRY_CODES.has(error?.code) || attempt >= RM_RETRY_DELAYS_MS.length) {
        throw error;
      }
      Atomics.wait(rmWaiter, 0, 0, RM_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 20_000,
    windowsHide: true,
    shell: false
  });
}

export function git(cwd, args) {
  const result = run("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

export function initRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "tests@example.com"]);
  git(dir, ["config", "user.name", "Plugin Tests"]);
  fs.writeFileSync(path.join(dir, "app.js"), "export const value = 1;\n", "utf8");
  git(dir, ["add", "app.js"]);
  git(dir, ["commit", "-m", "initial"]);
}

export function fakeGrokEnv(stateHome, overrides = {}) {
  return {
    ...process.env,
    GROK_COMPANION_HOME: stateHome,
    GROK_COMPANION_GROK_BINARY: process.execPath,
    GROK_COMPANION_GROK_PREFIX_ARGS: JSON.stringify([FAKE_GROK]),
    ...overrides
  };
}
