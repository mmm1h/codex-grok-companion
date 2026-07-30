import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT, tempDir, removeTempDir } from "./helpers.mjs";
import { archiveContent, packagePlugin } from "../scripts/package-plugin.mjs";
import { validateStore } from "../scripts/store-validate.mjs";

test("store submission material passes the release gate", () => {
  const result = validateStore(ROOT);
  assert.equal(result.skillCount, 5);
  assert.equal(result.positiveTests, 5);
  assert.equal(result.negativeTests, 3);
  assert.ok(result.files.length > 0);
  assert.ok(result.bytes > 0);
});

test("packaging normalizes text line endings without changing binary content", (t) => {
  const dir = tempDir("grok-package-content-");
  t.after(() => removeTempDir(dir));
  const textFile = path.join(dir, "fixture.md");
  const binaryFile = path.join(dir, "fixture.bin");
  fs.writeFileSync(textFile, "first\r\nsecond\rthird\n", "utf8");
  fs.writeFileSync(binaryFile, Buffer.from([0, 13, 10, 255]));

  assert.equal(archiveContent(textFile).toString("utf8"), "first\nsecond\nthird\n");
  assert.deepEqual(archiveContent(binaryFile), Buffer.from([0, 13, 10, 255]));
});

test("plugin packaging is deterministic and has one plugin root", async (t) => {
  const dir = tempDir("grok-package-test-");
  t.after(() => removeTempDir(dir));
  const first = path.join(dir, "first.zip");
  const second = path.join(dir, "second.zip");

  const firstResult = await packagePlugin({ root: ROOT, outPath: first });
  const secondResult = await packagePlugin({ root: ROOT, outPath: second });

  assert.equal(firstResult.root, "grok-companion");
  assert.equal(firstResult.fileCount, secondResult.fileCount);
  assert.equal(firstResult.verified.fileCount, firstResult.fileCount);
  assert.ok(firstResult.verified.uncompressedBytes > 0);
  assert.equal(fs.statSync(first).size, fs.statSync(second).size);
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(digest(first), digest(second));
});
