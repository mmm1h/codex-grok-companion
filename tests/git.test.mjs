import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  collectReviewContext,
  getWorkingTreeState,
  resolveReviewTarget
} from "../plugins/grok-companion/scripts/lib/git.mjs";
import { git, initRepo, tempDir } from "./helpers.mjs";

test("working-tree review includes staged, unstaged, and untracked context", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "new.txt"), "new content\n", "utf8");

  const state = getWorkingTreeState(repo);
  assert.equal(state.isDirty, true);
  assert.deepEqual(state.untracked, ["new.txt"]);

  const target = resolveReviewTarget(repo, { scope: "auto" });
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(repo, target);
  assert.equal(context.fileCount, 2);
  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.truncated, false);
  assert.match(context.content, /app\.js/);
  assert.match(context.content, /new content/);
  assert.match(context.content, /Unstaged Diff/);
});

test("branch review resolves an explicit base and reports committed changes", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  const base = "main";
  git(repo, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");
  git(repo, ["add", "app.js"]);
  git(repo, ["commit", "-m", "feature"]);
  const target = resolveReviewTarget(repo, { base });
  const context = collectReviewContext(repo, target);
  assert.equal(context.mode, "branch");
  assert.equal(context.fileCount, 1);
  assert.match(context.content, /feature/);
  assert.match(context.content, /value = 3/);
});

test("dirty branch self-collection falls back to clean commit-range evidence", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  git(repo, ["checkout", "-b", "feature"]);
  for (const file of ["one.js", "two.js", "three.js"]) {
    fs.writeFileSync(path.join(repo, file), `export const name = "${file}";\n`, "utf8");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "three files"]);
  fs.writeFileSync(path.join(repo, "one.js"), "export const dirty = true;\n", "utf8");

  const context = collectReviewContext(
    repo,
    resolveReviewTarget(repo, { base: "main" }),
    { maxInlineFiles: 2 }
  );
  // Uncommitted edits must not contaminate evidence, but a clean range diff is still usable.
  assert.equal(context.truncated, false);
  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /working tree is dirty/i);
  assert.match(context.content, /Branch Diff \(clean commit range\)/);
  assert.match(context.content, /export const name = "one\.js"/);
  assert.doesNotMatch(context.content, /export const dirty/);
});

test("dirty branch self-collection fails with actionable guidance when clean range is too large", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  git(repo, ["checkout", "-b", "feature"]);
  for (const file of ["one.js", "two.js", "three.js"]) {
    fs.writeFileSync(
      path.join(repo, file),
      Array.from({ length: 2_000 }, (_, index) => `export const ${file.replace(".", "_")}_${index} = ${index};`).join("\n"),
      "utf8"
    );
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "three large files"]);
  fs.writeFileSync(path.join(repo, "one.js"), "export const dirty = true;\n", "utf8");

  const context = collectReviewContext(repo, resolveReviewTarget(repo, { base: "main" }), {
    maxSelfCollectBytes: 2_048
  });
  assert.equal(context.truncated, true);
  assert.equal(context.inputMode, "truncated-diff");
  assert.match(context.content, /Collection Failure/);
  assert.match(context.content, /--scope working-tree/);
  assert.match(context.content, /[Ss]tash|commit local changes/);
  assert.doesNotMatch(context.content, /export const dirty/);
});

test("small multi-file reviews inline by default and honor an explicit file threshold", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "second.js"), "export const second = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "third.js"), "export const third = 3;\n", "utf8");

  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.truncated, false);
  assert.equal(context.fileCount, 3);
  assert.match(context.content, /export const value = 2/);

  const constrained = collectReviewContext(repo, target, { maxInlineFiles: 2 });
  assert.equal(constrained.inputMode, "self-collect");
  assert.equal(constrained.truncated, false);
  assert.match(constrained.content, /Changed Files/);
  assert.doesNotMatch(constrained.content, /export const value = 2/);
  assert.match(constrained.collectionGuidance, /read_file, grep, and list_dir/);
});

test("oversized diff uses self-collect while forced inline truncation remains explicit", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  fs.writeFileSync(
    path.join(repo, "app.js"),
    Array.from({ length: 40_000 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    "utf8"
  );
  const target = resolveReviewTarget(repo, { scope: "working-tree" });

  const selfCollected = collectReviewContext(repo, target);
  assert.equal(selfCollected.inputMode, "self-collect");
  assert.equal(selfCollected.truncated, false);
  assert.ok(selfCollected.diffBytes > 256 * 1024);
  assert.doesNotMatch(selfCollected.content, /diff truncated by grok companion/);

  const forcedInline = collectReviewContext(repo, target, { includeDiff: true, maxDiffBytes: 1024 });
  assert.equal(forcedInline.inputMode, "truncated-diff");
  assert.equal(forcedInline.truncated, true);
  assert.match(forcedInline.content, /diff truncated by grok companion/);

  const oversizedSummary = collectReviewContext(repo, target, {
    includeDiff: false,
    maxSelfCollectBytes: 128
  });
  assert.equal(oversizedSummary.truncated, true);
  assert.equal(oversizedSummary.inputMode, "truncated-diff");
  assert.match(oversizedSummary.content, /Collection Failure/);
  assert.doesNotMatch(oversizedSummary.content, /export const value39999/);
});

test("invalid review scope is rejected", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  assert.throws(() => resolveReviewTarget(repo, { scope: "staged" }), /Unsupported review scope/);
});

test("git UTF-8 config preserves non-ASCII paths in review evidence", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  const chineseName = "中文路径-测试.js";
  fs.writeFileSync(path.join(repo, chineseName), "export const 你好 = 1;\n", "utf8");

  const context = collectReviewContext(repo, resolveReviewTarget(repo, { scope: "working-tree" }));
  assert.equal(context.truncated, false);
  // core.quotepath=false keeps the literal path; content stays readable UTF-8.
  assert.match(context.content, /中文路径-测试\.js/);
  assert.doesNotMatch(context.content, /\\xxx/);
  assert.match(context.content, /你好/);
});

test("large binary changes are estimated cheaply and skip full binary dump", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  // Null bytes force Git binary detection; rewrite is large enough to exceed the inline threshold.
  const initial = Buffer.alloc(64 * 1024, 0);
  initial[0] = 0x11;
  fs.writeFileSync(path.join(repo, "blob.bin"), initial);
  git(repo, ["add", "blob.bin"]);
  git(repo, ["commit", "-m", "add binary"]);
  const binary = Buffer.alloc(400 * 1024, 0);
  binary[0] = 0xab;
  binary[1] = 0x00;
  fs.writeFileSync(path.join(repo, "blob.bin"), binary);

  const started = Date.now();
  const context = collectReviewContext(repo, resolveReviewTarget(repo, { scope: "working-tree" }));
  const elapsedMs = Date.now() - started;

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.truncated, false);
  assert.ok(context.diffBytes > 256 * 1024);
  // Estimation must stay cheap; a full --binary measure would buffer ~800KiB+ and be slower.
  assert.ok(elapsedMs < 15_000, `estimate/collect took too long: ${elapsedMs}ms`);
  assert.match(context.content, /blob\.bin/);
  // Self-collect path should not embed the raw binary payload.
  assert.ok(!context.content.includes("\0".repeat(20)));
});

test("forced inline with oversized change set avoids unbounded binary/submodule expansion", (t) => {
  const repo = tempDir();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo);
  const initial = Buffer.alloc(32 * 1024, 0);
  initial[0] = 0x22;
  fs.writeFileSync(path.join(repo, "heavy.bin"), initial);
  git(repo, ["add", "heavy.bin"]);
  git(repo, ["commit", "-m", "add heavy binary"]);
  const binary = Buffer.alloc(300 * 1024, 0);
  binary[0] = 0xcd;
  binary[1] = 0x00;
  fs.writeFileSync(path.join(repo, "heavy.bin"), binary);

  const context = collectReviewContext(repo, resolveReviewTarget(repo, { scope: "working-tree" }), {
    includeDiff: true,
    maxDiffBytes: 8_192
  });
  // Safe flags / maxBuffer keep collection bounded; binary payload must not be dumped raw.
  assert.ok(
    context.truncated === true
      || /Binary files|GIT binary patch|heavy\.bin/.test(context.content)
  );
  assert.ok(Buffer.byteLength(context.content, "utf8") < 200 * 1024);
});
