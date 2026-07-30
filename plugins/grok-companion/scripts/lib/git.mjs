import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 50;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 512 * 1024;
const DEFAULT_SELF_COLLECT_MAX_BYTES = 512 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024;
const ESTIMATED_BYTES_PER_CHANGED_LINE = 120;
const ESTIMATED_MISSING_BINARY_BYTES = 1024 * 1024;

// Force UTF-8-friendly path/log output so Windows GBK codepages do not mojibake
// non-ASCII paths or commit text before process.mjs decodes stdout as utf8.
const GIT_UTF8_CONFIG = [
  "-c", "core.quotepath=false",
  "-c", "i18n.logOutputEncoding=utf-8"
];

function git(cwd, args, options = {}) {
  return runCommand("git", [...GIT_UTF8_CONFIG, ...args], { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", [...GIT_UTF8_CONFIG, ...args], { cwd, ...options, shell: false });
}

function lines(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function formatSection(title, body) {
  return [`## ${title}`, "", String(body ?? "").trim() || "(none)", ""].join("\n");
}

function truncateUtf8(value, maxBytes) {
  const source = String(value ?? "");
  if (Buffer.byteLength(source, "utf8") <= maxBytes) {
    return { text: source, truncated: false };
  }
  const buffer = Buffer.from(source, "utf8").subarray(0, Math.max(0, maxBytes));
  return {
    text: `${buffer.toString("utf8").replace(/\uFFFD$/u, "")}\n\n[diff truncated by grok companion]`,
    truncated: true
  };
}

function splitNumstatLine(line) {
  const first = line.indexOf("\t");
  const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
  if (first < 0 || second < 0) {
    return null;
  }
  return {
    added: line.slice(0, first),
    deleted: line.slice(first + 1, second),
    filePath: line.slice(second + 1)
  };
}

function hasGitlinkChange(cwd, rangeArgs = []) {
  const raw = gitChecked(cwd, ["diff", "--raw", "--no-ext-diff", ...rangeArgs]).stdout;
  for (const line of lines(raw)) {
    const match = line.match(/^:(\d{6}) (\d{6}) /);
    if (match && (match[1] === "160000" || match[2] === "160000")) {
      return true;
    }
  }
  return false;
}

function safeResolveRepoPath(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return absolutePath;
}

function fileSizeOrZero(absolutePath) {
  try {
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return 0;
    }
    const stat = fs.statSync(absolutePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Cheap size estimate for thresholding. Avoids loading full --binary/--submodule=diff
 * output into memory (which can OOM on huge binaries or submodule expansions).
 */
function estimateDiffBytes(cwd, rangeArgs = []) {
  // Submodule content expansion is unbounded with --submodule=diff.
  if (hasGitlinkChange(cwd, rangeArgs)) {
    return Number.MAX_SAFE_INTEGER;
  }

  let estimated = 0;
  const numstat = gitChecked(cwd, ["diff", "--numstat", "--no-ext-diff", ...rangeArgs]).stdout;
  for (const line of lines(numstat)) {
    const parsed = splitNumstatLine(line);
    if (!parsed) {
      continue;
    }
    if (parsed.added === "-" && parsed.deleted === "-") {
      const absolutePath = safeResolveRepoPath(cwd, parsed.filePath);
      const size = fileSizeOrZero(absolutePath);
      // Binary diffs can approach ~2x the blob when fully replaced.
      estimated += size > 0 ? size * 2 : ESTIMATED_MISSING_BINARY_BYTES;
      continue;
    }
    const added = Number(parsed.added);
    const deleted = Number(parsed.deleted);
    estimated += ((Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0))
      * ESTIMATED_BYTES_PER_CHANGED_LINE;
  }

  // Lower-bound from on-disk sizes of changed paths. Covers full-file rewrites and
  // blobs Git may treat as a single "text" line (numstat under-reports payload size).
  let sizeBound = 0;
  const names = lines(gitChecked(cwd, ["diff", "--name-only", "--no-ext-diff", ...rangeArgs]).stdout);
  for (const filePath of names) {
    sizeBound += fileSizeOrZero(safeResolveRepoPath(cwd, filePath));
  }
  return Math.max(estimated, sizeBound);
}

function estimateCombinedDiffBytes(cwd, rangeArgSets) {
  let total = 0;
  for (const rangeArgs of rangeArgSets) {
    total += estimateDiffBytes(cwd, rangeArgs);
    if (total >= Number.MAX_SAFE_INTEGER / 2) {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  return total;
}

/** Untracked files are not in git diff output; include their sizes for thresholding. */
function estimateUntrackedBytes(repoRoot, untracked) {
  let total = 0;
  for (const relativePath of untracked) {
    try {
      const absolutePath = path.resolve(repoRoot, relativePath);
      const relative = path.relative(repoRoot, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      const stat = fs.statSync(absolutePath);
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
      // ignore unreadable paths
    }
  }
  return total;
}

function fullDiffArgs(rangeArgs = []) {
  return ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...rangeArgs];
}

/** Safe diff args: skip binary dumps and submodule content expansion. */
function safeDiffArgs(rangeArgs = []) {
  return ["diff", "--no-ext-diff", "--submodule=log", ...rangeArgs];
}

function readDiff(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error?.code === "ENOBUFS") {
    const partial = truncateUtf8(result.stdout, maxBytes);
    return {
      text: partial.text,
      truncated: true,
      measuredBytes: maxBytes + 1
    };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return {
    ...truncateUtf8(result.stdout, maxBytes),
    measuredBytes: Buffer.byteLength(result.stdout, "utf8")
  };
}

/**
 * Read a diff for review evidence. When the change set includes binaries or
 * gitlinks, prefer safe flags so collection itself cannot expand unbounded content.
 */
function readReviewDiff(cwd, rangeArgs, maxBytes) {
  if (hasGitlinkChange(cwd, rangeArgs) || estimateDiffBytes(cwd, rangeArgs) > maxBytes) {
    return readDiff(cwd, safeDiffArgs(rangeArgs), maxBytes);
  }
  return readDiff(cwd, fullDiffArgs(rangeArgs), maxBytes);
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const value = symbolic.stdout.trim();
    if (value.startsWith("refs/remotes/origin/")) {
      return value.slice("refs/remotes/origin/".length);
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getWorkingTreeState(cwd) {
  const staged = lines(gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout);
  const unstaged = lines(gitChecked(cwd, ["diff", "--name-only"]).stdout);
  const untracked = lines(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout);
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length + unstaged.length + untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new Error(`Unsupported review scope "${scope}". Use auto, working-tree, or branch.`);
  }
  if (options.base) {
    return { mode: "branch", label: `branch diff against ${options.base}`, baseRef: options.base, explicit: true };
  }
  if (scope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", baseRef: null, explicit: true };
  }
  if (scope === "branch") {
    const baseRef = detectDefaultBranch(cwd);
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true };
  }
  if (getWorkingTreeState(cwd).isDirty) {
    return { mode: "working-tree", label: "working tree diff", baseRef: null, explicit: false };
  }
  const baseRef = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: false };
}

function formatUntrackedFile(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `### ${relativePath}\n(skipped: path escapes repository)`;
  }
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return `### ${relativePath}\n(skipped: not a regular file)`;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_FILE_BYTES} byte limit)`;
    }
    const content = fs.readFileSync(absolutePath);
    if (!isProbablyText(content)) {
      return `### ${relativePath}\n(skipped: binary file)`;
    }
    return [`### ${relativePath}`, "```text", content.toString("utf8").trimEnd(), "```"].join("\n");
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function selfCollectionGuidance() {
  return [
    "The complete diff is intentionally not inline because this review exceeds the inline evidence threshold.",
    "Treat the changed-files list as the review scope and use only the available read-only tools (read_file, grep, and list_dir) to inspect every relevant changed file and its surrounding code before deciding.",
    "Do not infer the contents of unread files or treat this summary as a complete patch. Deleted paths cannot be read, so make claims only when the status/stat and readable repository evidence support them."
  ].join(" ");
}

function inlineCollectionGuidance() {
  return "The complete tracked diff is inline below. Use it as primary evidence and use the available read-only tools for surrounding repository context when needed.";
}

function dirtyBranchFallbackGuidance() {
  return [
    "The working tree is dirty, so read_file/grep/list_dir may observe uncommitted content that is not part of the selected commit range.",
    "Primary evidence is the clean commit-range branch diff and metadata below; do not treat working-tree file reads as authoritative for this branch review."
  ].join(" ");
}

function dirtyBranchFailureMessage() {
  return [
    "Branch self-collection cannot safely verify the selected commit range while the working tree is dirty and the clean commit-range diff exceeds the evidence budget.",
    "Options:",
    "1) Re-run with --scope working-tree to review uncommitted changes instead of the branch range.",
    "2) Stash or commit local changes, then re-run the branch review on a clean tree so self-collection can read committed files.",
    "3) Narrow the review (fewer commits / smaller diff) after cleaning, or pass an explicit --base on a clean tree."
  ].join(" ");
}

function collectWorkingTreeContext(repoRoot, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const maxDiffBytes = options.maxDiffBytes;
  const changedFiles = uniqueFiles(state.staged, state.unstaged, state.untracked);
  const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout;

  if (!includeDiff) {
    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      changedFiles,
      truncated: false,
      collectionGuidance: selfCollectionGuidance(),
      content: [
        formatSection("Collection Guidance", selfCollectionGuidance()),
        formatSection("Git Status", status),
        formatSection("Changed Files", changedFiles.join("\n")),
        formatSection("Staged Diff Stat", gitChecked(repoRoot, ["diff", "--stat", "--cached"]).stdout),
        formatSection("Unstaged Diff Stat", gitChecked(repoRoot, ["diff", "--stat"]).stdout)
      ].join("\n")
    };
  }

  const staged = readReviewDiff(repoRoot, ["--cached"], maxDiffBytes);
  const remaining = Math.max(0, maxDiffBytes - Buffer.byteLength(staged.text, "utf8"));
  const unstaged = readReviewDiff(repoRoot, [], remaining);
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(repoRoot, file)).join("\n\n");
  const truncated = staged.truncated || unstaged.truncated;
  const guidance = truncated
    ? "The requested inline diff was truly truncated while collecting evidence. Do not approve this review."
    : inlineCollectionGuidance();

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    changedFiles,
    truncated,
    collectionGuidance: guidance,
    content: [
      formatSection("Collection Guidance", guidance),
      formatSection("Git Status", status),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Staged Diff", staged.text),
      formatSection("Unstaged Diff", unstaged.text),
      formatSection("Untracked Files", untrackedBody)
    ].join("\n")
  };
}

function collectBranchContext(repoRoot, baseRef, comparison, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const changedFiles = lines(gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout);
  const commitLog = gitChecked(repoRoot, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout;
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", comparison.commitRange]).stdout;

  if (!includeDiff) {
    return {
      mode: "branch",
      summary: `Reviewing branch ${getCurrentBranch(repoRoot)} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
      changedFiles,
      comparison,
      truncated: false,
      collectionGuidance: selfCollectionGuidance(),
      content: [
        formatSection("Collection Guidance", selfCollectionGuidance()),
        formatSection("Commit Log", commitLog),
        formatSection("Diff Stat", diffStat),
        formatSection("Changed Files", changedFiles.join("\n"))
      ].join("\n")
    };
  }

  const diff = readReviewDiff(repoRoot, [comparison.commitRange], options.maxDiffBytes);
  const guidance = diff.truncated
    ? "The requested inline diff was truly truncated while collecting evidence. Do not approve this review."
    : inlineCollectionGuidance();
  return {
    mode: "branch",
    summary: `Reviewing branch ${getCurrentBranch(repoRoot)} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    changedFiles,
    comparison,
    truncated: diff.truncated,
    collectionGuidance: guidance,
    content: [
      formatSection("Collection Guidance", guidance),
      formatSection("Commit Log", commitLog),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Branch Diff", diff.text)
    ].join("\n")
  };
}

/**
 * When branch self-collection would rely on dirty working-tree file reads, fall
 * back to the clean commit-range diff (unaffected by uncommitted edits). If that
 * still exceeds the evidence budget, fail with actionable recovery steps.
 *
 * Full temporary worktree checkout was considered but needs companion-side cwd
 * lifecycle/cleanup outside this module; embedding the clean range diff keeps
 * the fix local and safe.
 */
function applyDirtyBranchSelfCollectFallback(repoRoot, details, comparison, maxSelfCollectBytes) {
  const guidance = dirtyBranchFallbackGuidance();
  // Prefer safe flags: commit-range text is enough; avoid binary/submodule expansion.
  const cleanDiff = readDiff(
    repoRoot,
    safeDiffArgs([comparison.commitRange]),
    maxSelfCollectBytes
  );
  const content = [
    formatSection("Collection Guidance", guidance),
    formatSection("Commit Log", gitChecked(repoRoot, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout),
    formatSection("Diff Stat", gitChecked(repoRoot, ["diff", "--stat", comparison.commitRange]).stdout),
    formatSection("Changed Files", details.changedFiles.join("\n")),
    formatSection("Branch Diff (clean commit range)", cleanDiff.text)
  ].join("\n");

  if (cleanDiff.truncated || Buffer.byteLength(content, "utf8") > maxSelfCollectBytes) {
    const failure = dirtyBranchFailureMessage();
    return {
      ...details,
      truncated: true,
      collectionGuidance: `${failure} Do not approve this review.`,
      content: formatSection("Collection Failure", failure)
    };
  }

  return {
    ...details,
    truncated: false,
    collectionGuidance: guidance,
    content
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const maxInlineFiles = normalizeLimit(options.maxInlineFiles, DEFAULT_INLINE_DIFF_MAX_FILES);
  const maxInlineDiffBytes = normalizeLimit(options.maxInlineDiffBytes, DEFAULT_INLINE_DIFF_MAX_BYTES);
  const maxDiffBytes = normalizeLimit(options.maxDiffBytes, maxInlineDiffBytes);
  const maxSelfCollectBytes = normalizeLimit(options.maxSelfCollectBytes, DEFAULT_SELF_COLLECT_MAX_BYTES);
  let details;
  let diffBytes;
  let includeDiff;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const changedFiles = uniqueFiles(state.staged, state.unstaged, state.untracked);
    // Cheap numstat/raw estimate — never pull full --binary/--submodule=diff just to measure.
    diffBytes = estimateCombinedDiffBytes(repoRoot, [["--cached"], []])
      + estimateUntrackedBytes(repoRoot, state.untracked);
    includeDiff = options.includeDiff ?? (
      changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff, maxDiffBytes });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const changedFiles = lines(gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout);
    diffBytes = estimateDiffBytes(repoRoot, [comparison.commitRange]);
    includeDiff = options.includeDiff ?? (
      changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectBranchContext(repoRoot, target.baseRef, comparison, { includeDiff, maxDiffBytes });
    if (!includeDiff && getWorkingTreeState(repoRoot).isDirty) {
      details = applyDirtyBranchSelfCollectFallback(
        repoRoot,
        details,
        comparison,
        maxSelfCollectBytes
      );
    }
  }

  if (!includeDiff && Buffer.byteLength(details.content, "utf8") > maxSelfCollectBytes) {
    const failure = `Self-collection summary exceeded the ${maxSelfCollectBytes} byte evidence limit. Refusing to provide a partial file list or diff stat.`;
    details = {
      ...details,
      truncated: true,
      collectionGuidance: `${failure} Do not approve this review.`,
      content: formatSection("Collection Failure", failure)
    };
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: getCurrentBranch(repoRoot),
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: details.truncated ? "truncated-diff" : (includeDiff ? "inline-diff" : "self-collect"),
    ...details
  };
}
