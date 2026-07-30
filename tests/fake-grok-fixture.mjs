#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const promptFileIndex = args.indexOf("--prompt-file");
const inlineIndex = args.indexOf("-p");
const jsonSchemaIndex = args.indexOf("--json-schema");
const sandboxIndex = args.indexOf("--sandbox");
const outputFormatIndex = args.indexOf("--output-format");
const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const continueIndex = args.indexOf("--continue");
const sessionId = sessionIdIndex === -1
  ? (resumeIndex === -1 ? null : args[resumeIndex + 1])
  : args[sessionIdIndex + 1];

if (args.includes("--help")) {
  process.stdout.write(process.env.FAKE_GROK_HELP || [
    "Usage: fake-grok",
    "  --json-schema <SCHEMA>",
    "  --sandbox <PROFILE>",
    "  --output-format plain|json|streaming-json",
    ""
  ].join("\n"));
  process.exit(0);
}

const capture = {
  args,
  cwd: process.cwd(),
  jsonSchema: jsonSchemaIndex === -1 ? null : args[jsonSchemaIndex + 1],
  sandbox: sandboxIndex === -1 ? null : args[sandboxIndex + 1],
  outputFormat: outputFormatIndex === -1 ? null : args[outputFormatIndex + 1],
  sessionId,
  resumeSessionId: resumeIndex === -1 ? null : args[resumeIndex + 1],
  continued: continueIndex !== -1,
  promptFile: promptFileIndex === -1 ? null : args[promptFileIndex + 1],
  prompt: promptFileIndex !== -1
    ? fs.readFileSync(args[promptFileIndex + 1], "utf8")
    : (inlineIndex === -1 ? "" : args[inlineIndex + 1])
};

if (process.env.FAKE_GROK_CAPTURE) {
  fs.writeFileSync(process.env.FAKE_GROK_CAPTURE, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

const stderrFlood = Number(process.env.FAKE_GROK_STDERR_FLOOD || 0);
if (Number.isFinite(stderrFlood) && stderrFlood > 0) {
  for (let index = 0; index < stderrFlood; index += 1) {
    process.stderr.write(`fake grok progress line ${index}\n`);
  }
} else {
  process.stderr.write("fake grok progress\n");
}

/**
 * Parse FAKE_GROK_STREAM_CHUNKS:
 * - JSON array of strings → write those pieces as separate stdout writes
 * - positive number (JSON or bare) → slice the body into that many bytes per write
 * - unset → single write (legacy behavior)
 */
function parseStreamChunks() {
  const raw = process.env.FAKE_GROK_STREAM_CHUNKS;
  if (raw == null || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { kind: "parts", parts: parsed.map((part) => String(part)) };
    }
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return { kind: "bytes", size: Math.floor(parsed) };
    }
  } catch {
    // bare integer like "7"
  }
  const size = Number(raw);
  if (Number.isFinite(size) && size > 0) {
    return { kind: "bytes", size: Math.floor(size) };
  }
  return null;
}

function countCompletedLines(text) {
  const matches = String(text).match(/\n/g);
  return matches ? matches.length : 0;
}

/**
 * Write stdout body with optional byte/part chunking and mid-stream crash.
 * FAKE_GROK_EXIT_AFTER_LINES: exit as soon as this many newline-terminated lines have been written.
 * When set without STREAM_CHUNKS, the body is emitted one line at a time so the crash is mid-stream.
 */
async function writeStdoutBody(body) {
  const text = String(body ?? "");
  const chunkSpec = parseStreamChunks();
  const exitAfterRaw = process.env.FAKE_GROK_EXIT_AFTER_LINES;
  const exitAfter = exitAfterRaw == null || exitAfterRaw === ""
    ? null
    : Number(exitAfterRaw);
  let linesWritten = 0;

  const writePiece = (piece) => {
    if (!piece) {
      return;
    }
    process.stdout.write(piece);
    linesWritten += countCompletedLines(piece);
    if (exitAfter != null && Number.isFinite(exitAfter) && linesWritten >= exitAfter) {
      process.exit(Number(process.env.FAKE_GROK_EXIT_CODE || 1));
    }
  };

  if (chunkSpec?.kind === "parts") {
    // Explicit parts fully define what is written (body is ignored).
    for (const part of chunkSpec.parts) {
      writePiece(part);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return;
  }

  if (chunkSpec?.kind === "bytes") {
    for (let offset = 0; offset < text.length; offset += chunkSpec.size) {
      writePiece(text.slice(offset, offset + chunkSpec.size));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return;
  }

  // Mid-stream crash needs line-at-a-time writes; a single write would flush everything first.
  if (exitAfter != null && Number.isFinite(exitAfter)) {
    const parts = text.split(/(?<=\n)/);
    for (const part of parts) {
      writePiece(part);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return;
  }

  writePiece(text);
}

if (process.env.FAKE_GROK_FAIL_BEFORE_SESSION === "1") {
  process.stderr.write("fake grok failed before creating a session\n");
  process.exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || 1);
} else if (
  capture.outputFormat === "streaming-json"
  && !process.env.FAKE_GROK_STREAM
  && !process.env.FAKE_GROK_STREAM_CHUNKS
) {
  // Default streaming preamble only when the caller did not supply a full custom stream.
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  if (process.env.FAKE_GROK_MALFORMED_EVENT === "1") {
    process.stdout.write("not-json-stream-event\n");
  }
  if (process.env.FAKE_GROK_UNKNOWN_EVENT === "1") {
    process.stdout.write(`${JSON.stringify({ type: "future_event", detail: "preserve me" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "tool_use", name: "read_file", session_id: sessionId })}\n`);
}

const delay = Number(process.env.FAKE_GROK_DELAY_MS || 0);
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const defaultReview = {
  verdict: "approve",
  summary: "No actionable defects found.",
  findings: [],
  next_steps: ["Retain the current test coverage."]
};
const requestedSchema = capture.jsonSchema ? JSON.parse(capture.jsonSchema) : null;
const defaultStructuredOutput = requestedSchema?.properties?.decision
  ? { decision: "allow", reason: "No blocking issue was introduced in the previous turn." }
  : defaultReview;

if (process.env.FAKE_GROK_FAIL_BEFORE_SESSION !== "1") {
  const output = process.env.FAKE_GROK_OUTPUT || "FAKE_GROK_OK";
  const chunkSpec = parseStreamChunks();

  if (capture.outputFormat === "streaming-json") {
    if (chunkSpec?.kind === "parts") {
      // Adversarial cross-chunk fixtures supply the entire stream as parts.
      await writeStdoutBody("");
    } else if (process.env.FAKE_GROK_STREAM) {
      await writeStdoutBody(`${process.env.FAKE_GROK_STREAM.replace(/\n?$/, "\n")}`);
    } else {
      const body = [
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: output }] }, session_id: sessionId })}\n`,
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          result: output,
          stopReason: "EndTurn",
          session_id: sessionId
        })}\n`
      ].join("");
      await writeStdoutBody(body);
    }
  } else {
    const plainBody = process.env.FAKE_GROK_OUTPUT != null
      ? `${process.env.FAKE_GROK_OUTPUT}\n`
      : (jsonSchemaIndex === -1
        ? `${output}\n`
        : `${JSON.stringify({
          text: JSON.stringify(defaultStructuredOutput),
          stopReason: "EndTurn",
          sessionId
        })}\n`);
    await writeStdoutBody(plainBody);
  }

  // Optional late write after an extra delay (parent may have timed out already).
  const postDelay = Number(process.env.FAKE_GROK_POST_DELAY_MS || 0);
  if (postDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, postDelay));
    const late = process.env.FAKE_GROK_POST_OUTPUT ?? "FAKE_GROK_LATE\n";
    process.stdout.write(late.endsWith("\n") ? late : `${late}\n`);
  }

  process.exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || 0);
}
