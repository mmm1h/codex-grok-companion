import fs from "node:fs";
import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

const workspaceCache = new Map();

/**
 * Canonical absolute path for non-git workspaces so state/resume share one bucket
 * across drive-letter case, junctions, and path aliases (best-effort realpath).
 */
function normalizeNonGitWorkspaceRoot(resolvedCwd) {
  try {
    return fs.realpathSync.native(resolvedCwd);
  } catch (error) {
    // Path missing or unreadable: keep resolved absolute path, surface a one-line hint.
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `grok-companion: could not canonicalize non-git workspace "${resolvedCwd}" (${detail}); `
      + "status/resume may not find jobs created via a different path alias.\n"
    );
    return resolvedCwd;
  }
}

export function resolveWorkspaceRoot(cwd) {
  const key = path.resolve(cwd);
  if (workspaceCache.has(key)) {
    return workspaceCache.get(key);
  }
  let workspaceRoot;
  try {
    workspaceRoot = ensureGitRepository(key);
  } catch {
    workspaceRoot = normalizeNonGitWorkspaceRoot(key);
  }
  workspaceCache.set(key, workspaceRoot);
  return workspaceRoot;
}
