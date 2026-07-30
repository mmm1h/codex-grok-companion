import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 100];
const RETRIABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const retryWaiter = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(retryWaiter, 0, 0, milliseconds);
}

export function ensureAbsolutePath(cwd, value) {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/") || String(value).startsWith("~\\")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function createTempDir(prefix = "grok-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFileAtomic(filePath, value, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const renameSync = options.renameSync ?? fs.renameSync;
  const wait = options.sleepSync ?? sleepSync;
  let renamed = false;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tempFile, filePath);
        renamed = true;
        return;
      } catch (error) {
        if (!RETRIABLE_RENAME_CODES.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        wait(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Preserve the write error if temporary-file cleanup also fails.
      }
    }
  }
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.some((value) => value === 0);
}

export function readStdinIfPiped() {
  return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
}
