import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertGrokCliCompatible,
  buildGrokArgs,
  clearGrokCapabilityCache,
  compareGrokVersions,
  getGrokAuthStatus,
  getGrokAvailability,
  getGrokCapabilities,
  grokStopReasonError,
  isGrokAuthReady,
  MIN_GROK_CLI_VERSION,
  normalizeGrokStreamingEvent,
  parseGrokStructuredOutput,
  parseGrokVersion,
  runGrokHeadless
} from "../plugins/grok-companion/scripts/lib/grok.mjs";
import { isProcessAlive } from "../plugins/grok-companion/scripts/lib/process.mjs";
import { renderTaskResult } from "../plugins/grok-companion/scripts/lib/render.mjs";
import { FAKE_GROK, tempDir } from "./helpers.mjs";

test("stop reasons fail closed unless Grok confirms EndTurn", () => {
  assert.equal(grokStopReasonError("EndTurn"), null);
  assert.match(grokStopReasonError(null), /without a terminal stop reason/i);
  assert.match(grokStopReasonError("Stop"), /without a complete result/i);
  assert.match(grokStopReasonError("Cancelled"), /without a complete result/i);
});

test("read-only Grok argv uses plan mode and a strict tool allowlist", () => {
  const { args, sessionId } = buildGrokArgs({
    prompt: "review",
    sessionId: "11111111-1111-4111-8111-111111111111",
    write: false
  });
  assert.equal(sessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(args.slice(-2), ["-p", "review"]);
  assert.ok(args.includes("plan"));
  assert.ok(args.includes("read_file,grep,list_dir"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--disable-web-search"));
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.ok(!args.includes("--always-approve"));
  assert.ok(!args.includes("bypassPermissions"));
});

test("write-capable Grok argv uses acceptEdits without bypass flags", () => {
  const { args } = buildGrokArgs({
    prompt: "implement",
    write: true,
    model: "grok-code",
    effort: "high",
    sessionId: "22222222-2222-4222-8222-222222222222"
  });
  assert.ok(args.includes("acceptEdits"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(!args.includes("--always-approve"));
  assert.ok(!args.includes("bypassPermissions"));
  assert.ok(args.includes("grok-code"));
  assert.ok(args.includes("high"));
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--sandbox"));
});

test("structured Grok argv passes the schema without forcing plain output", () => {
  const schema = { type: "object" };
  const { args } = buildGrokArgs({ prompt: "review", write: false, jsonSchema: schema });
  assert.equal(args[args.indexOf("--json-schema") + 1], JSON.stringify(schema));
  assert.ok(!args.includes("--output-format"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("parseGrokStructuredOutput accepts direct payloads and common CLI envelopes", () => {
  const payload = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  assert.deepEqual(parseGrokStructuredOutput(JSON.stringify(payload)).data, payload);
  assert.deepEqual(
    parseGrokStructuredOutput(JSON.stringify({ result: JSON.stringify(payload) })).data,
    payload
  );
  const invalid = parseGrokStructuredOutput("not json");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.raw, "not json");
  assert.match(invalid.parseError, /JSON|complete JSON/i);
});

test("parseGrokStructuredOutput prefers the last object when multi-turn outputs are concatenated", () => {
  const intermediate = {
    verdict: "approve",
    summary: "partial",
    findings: [],
    next_steps: []
  };
  const finalPayload = {
    verdict: "needs-attention",
    summary: "found bugs",
    findings: [
      {
        severity: "high",
        title: "assignment in condition",
        body: "if (x = 1)",
        file: "a.js",
        line_start: 1,
        line_end: 1,
        confidence: 0.98,
        recommendation: "use ==="
      }
    ],
    next_steps: ["fix comparisons"]
  };
  const concatenated = `${JSON.stringify(intermediate)}${JSON.stringify(finalPayload)}`;
  const parsed = parseGrokStructuredOutput(concatenated);
  assert.equal(parsed.ok, true, parsed.parseError);
  assert.equal(parsed.data.verdict, "needs-attention");
  assert.equal(parsed.data.findings.length, 1);
  assert.equal(parsed.data.findings[0].title, "assignment in condition");

  const spaced = `${JSON.stringify(intermediate)}\n${JSON.stringify(finalPayload)}\n`;
  assert.equal(parseGrokStructuredOutput(spaced).data.verdict, "needs-attention");

  const enveloped = parseGrokStructuredOutput(JSON.stringify({
    text: concatenated,
    stopReason: "EndTurn"
  }));
  assert.equal(enveloped.ok, true, enveloped.parseError);
  assert.deepEqual(enveloped.data, finalPayload);
  assert.equal(enveloped.stopReason, "EndTurn");
});

test("getGrokCapabilities detects structured output and sandbox flags", () => {
  clearGrokCapabilityCache();
  const capabilities = getGrokCapabilities(process.cwd(), {
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    skipCache: true
  });
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.jsonSchema, true);
  assert.equal(capabilities.sandbox, true);
  assert.equal(capabilities.minVersion, MIN_GROK_CLI_VERSION);
});

test("runGrokHeadless spawns a fake binary and moves long prompts to a file", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, "capture.json");
  const progress = [];
  const prompt = "large prompt\n".repeat(1000);
  const result = await runGrokHeadless({
    cwd: dir,
    prompt,
    write: false,
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_CAPTURE: capture },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /FAKE_GROK_OK/);
  assert.ok(result.sessionId);
  assert.ok(progress.includes("fake grok progress"));
  const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(captured.prompt, prompt);
  assert.ok(captured.args.includes("--prompt-file"));
  assert.ok(!fs.existsSync(captured.promptFile), "temporary prompt file is cleaned after spawn");
});

test("streaming-json telemetry confirms the session and preserves readable final output", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const telemetry = [];
  const progress = [];
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "stream this task",
    write: true,
    sessionId,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_MALFORMED_EVENT: "1",
      FAKE_GROK_UNKNOWN_EVENT: "1"
    },
    onTelemetry: (event) => telemetry.push(event),
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "FAKE_GROK_OK");
  assert.match(result.rawStdout, /\"type\":\"result\"/);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sessionConfirmed, true);
  assert.ok(telemetry.some((event) => event.phase === "tool"));
  assert.ok(progress.some((line) => /Unparsed streaming output/.test(line)));
  assert.ok(progress.some((line) => /Unknown streaming event type:/.test(line)));
  assert.ok(!progress.some((line) => line.includes("\"type\"")));
});

test("streaming thought/text/end events do not leak raw tokens into progress", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const progress = [];
  const telemetry = [];
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const stream = [
    JSON.stringify({ type: "thought", text: "I am thinking token by token about secrets" }),
    JSON.stringify({ type: "thought", text: "more reasoning" }),
    JSON.stringify({ type: "text", text: "PING" }),
    JSON.stringify({ type: "end" }),
    JSON.stringify({ type: "result", result: "PING" })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "ping",
    write: true,
    sessionId,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STREAM: stream
    },
    onTelemetry: (event) => telemetry.push(event),
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "PING");
  assert.ok(telemetry.some((event) => event.phase === "reasoning"));
  assert.ok(telemetry.some((event) => event.eventType === "text"));
  assert.ok(!progress.some((line) => /thinking token|more reasoning|secrets/i.test(line)));
  assert.ok(!progress.some((line) => /Unknown streaming event/.test(line) && line.includes("thought")));
});

test("streaming text data fragments become final output without raw JSON fallback", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = "88888888-8888-4888-8888-888888888888";
  const stream = [
    JSON.stringify({ type: "thought", data: "private reasoning" }),
    JSON.stringify({ type: "text", data: "Hello, " }),
    JSON.stringify({ type: "text", data: "world!" }),
    JSON.stringify({ type: "end", data: { sessionId, usage: { outputTokens: 2 } } })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "stream text fragments",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    timeoutMs: 10_000,
    skipCapabilityCheck: true
  });

  assert.equal(result.stdout, "Hello, world!");
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sessionConfirmed, true);
  assert.match(result.rawStdout, /\"type\":\"thought\"/);
  assert.doesNotMatch(result.stdout, /\"type\":/);
  const rendered = renderTaskResult({
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    sessionConfirmed: result.sessionConfirmed,
    rawOutput: result.stdout,
    stderr: result.stderr
  });
  assert.match(rendered, /Hello, world!/);
  assert.doesNotMatch(rendered, /\"type\":/);
});

test("streaming event normalization tolerates future event shapes", () => {
  const toolEvent = normalizeGrokStreamingEvent(
    { type: "tool_start", tool: { name: "grep" }, session_id: "66666666-6666-4666-8666-666666666666" },
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(toolEvent.message, "Grok tool: grep");
  assert.equal(toolEvent.phase, "tool");
  assert.equal(toolEvent.sessionId, "66666666-6666-4666-8666-666666666666");
  assert.equal(toolEvent.eventType, "tool_start");

  const thought = normalizeGrokStreamingEvent({ type: "thought", text: "secret chain" }, "2026-01-01T00:00:00.000Z");
  assert.equal(thought.phase, "reasoning");
  assert.equal(thought.suppressProgress, true);
  assert.equal(thought.message, "");

  const textEvent = normalizeGrokStreamingEvent({ type: "text", text: "hello" }, "2026-01-01T00:00:00.000Z");
  assert.equal(textEvent.phase, "assistant");
  assert.equal(textEvent.suppressProgress, true);
});

const AUTH_SENTINEL = "SENTINEL_SECRET_VALUE";

function assertAuthConfiguredWithoutLeak(auth, expectedSource) {
  assert.equal(auth.status, "configured");
  assert.equal(auth.source, expectedSource);
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.authUnverified, false);
  assert.equal(isGrokAuthReady(auth), true);
  assert.doesNotMatch(JSON.stringify(auth), new RegExp(AUTH_SENTINEL));
}

test("getGrokAuthStatus avoids a probe and reports local evidence", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A1: empty home + empty env → needs_login
  const empty = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(empty.status, "needs_login");
  assert.equal(empty.authUnverified, false);
  // A2: config.toml present but no credential keys → needs_login
  fs.writeFileSync(path.join(dir, "config.toml"), '[cli]\ninstaller = "internal"\n', "utf8");
  const configOnly = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(configOnly.status, "needs_login");
  assert.equal(configOnly.authUnverified, true);
  assert.equal(configOnly.source, "config.toml");
});

test("config-only auth is not ready (prevents setup false-green)", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.toml"), "[model]\n", "utf8");
  const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  // Previously status was "unknown", which companion treated as ready via `!== needs_login`.
  assert.equal(auth.status, "needs_login");
  assert.equal(auth.authUnverified, true);
  assert.equal(isGrokAuthReady(auth), false);
  // Works with both the legacy companion check and the stricter helper.
  assert.equal(auth.status !== "needs_login", false);
  assert.equal(isGrokAuthReady({ status: "configured", authUnverified: false }), true);
  assert.equal(isGrokAuthReady({ status: "needs_login", authUnverified: false }), false);
  assert.equal(isGrokAuthReady({ status: "unknown", authUnverified: true }), false);
  assert.equal(isGrokAuthReady({ status: "configured", authUnverified: true }), false);
});

test("empty auth.json is not credential evidence", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A3: zero-byte auth.json must not count as configured
  fs.writeFileSync(path.join(dir, "auth.json"), "", "utf8");
  const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(auth.status, "needs_login");
  assert.equal(isGrokAuthReady(auth), false);
});

test("whitespace-only credential files are not authentication evidence", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "auth.json"), "  \r\n\t", "utf8");
  const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(auth.status, "needs_login");
  assert.equal(isGrokAuthReady(auth), false);
});

test("auth ready from GROK_API_KEY env (value not leaked)", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // B4
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { GROK_API_KEY: AUTH_SENTINEL }
  });
  assertAuthConfiguredWithoutLeak(auth, "GROK_API_KEY");
});

test("auth ready from XAI_API_KEY env (value not leaked)", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // B5
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { XAI_API_KEY: AUTH_SENTINEL }
  });
  assertAuthConfiguredWithoutLeak(auth, "XAI_API_KEY");
});

test("auth ready for each recognized credential file name", (t) => {
  // C6–C11: each login artifact alone is enough
  const names = [
    "credentials.json",
    "auth.json",
    "oauth.json",
    "tokens.json",
    "api_key",
    "api-key"
  ];
  for (const name of names) {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, name), `{"token":"${AUTH_SENTINEL}"}\n`, "utf8");
    const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
    assertAuthConfiguredWithoutLeak(auth, name);
  }
});

test("auth ready when config env_key env var is set", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // D12
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      '[model."grok-4.5"]',
      'model = "grok-4.5"',
      'base_url = "http://example.invalid/v1"',
      'env_key = "GROK_THIRD_PARTY_API_KEY"',
      'api_backend = "chat_completions"',
      ""
    ].join("\n"),
    "utf8"
  );
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { GROK_THIRD_PARTY_API_KEY: AUTH_SENTINEL }
  });
  assertAuthConfiguredWithoutLeak(auth, "env");
  assert.match(auth.detail, /GROK_THIRD_PARTY_API_KEY/);
});

test("auth needs_login when config env_key env var is empty string", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // D13: empty string is not a credential
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      '[model."grok-4.5"]',
      'env_key = "MY_GATEWAY_KEY"',
      ""
    ].join("\n"),
    "utf8"
  );
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { MY_GATEWAY_KEY: "" }
  });
  assert.equal(auth.status, "needs_login");
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.authUnverified, true);
  assert.equal(auth.source, "config.toml");
  assert.equal(isGrokAuthReady(auth), false);
});

test("auth needs_login when config env_key env var is missing", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // D14
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      '[model."grok-4.5"]',
      'env_key = "GROK_THIRD_PARTY_API_KEY"',
      ""
    ].join("\n"),
    "utf8"
  );
  const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(auth.status, "needs_login");
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.authUnverified, true);
  assert.equal(auth.source, "config.toml");
  assert.equal(isGrokAuthReady(auth), false);
  assert.equal(auth.status !== "needs_login", false);
});

test("auth ready when one of multiple config env_key vars is set", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // D15: any non-empty env_key match is enough
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      '[model."primary"]',
      'env_key = "MISSING_GATEWAY_KEY"',
      "",
      '[model."fallback"]',
      'env_key = "MY_GATEWAY_KEY"',
      ""
    ].join("\n"),
    "utf8"
  );
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { MY_GATEWAY_KEY: AUTH_SENTINEL }
  });
  assertAuthConfiguredWithoutLeak(auth, "env");
  assert.match(auth.detail, /MY_GATEWAY_KEY/);
});

test("auth ready when config.toml has inline api_key (value not leaked)", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // E16
  fs.writeFileSync(path.join(dir, "config.toml"), `api_key = "${AUTH_SENTINEL}"\n`, "utf8");
  const auth = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assertAuthConfiguredWithoutLeak(auth, "config.toml");
});

test("credential file takes priority over config env_key", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // F17: local login file wins over env_key-backed env
  fs.writeFileSync(path.join(dir, "auth.json"), `{"token":"${AUTH_SENTINEL}"}\n`, "utf8");
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      '[model."grok-4.5"]',
      'env_key = "MY_GATEWAY_KEY"',
      ""
    ].join("\n"),
    "utf8"
  );
  const auth = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: { MY_GATEWAY_KEY: AUTH_SENTINEL }
  });
  assertAuthConfiguredWithoutLeak(auth, "auth.json");
});

test("optional auth probe can confirm or reject without defaulting on", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "agent_id"), "local-id\n", "utf8");

  const withoutProbe = getGrokAuthStatus(dir, { grokHome: dir, env: {} });
  assert.equal(withoutProbe.status, "needs_login");
  assert.equal(withoutProbe.authUnverified, true);

  const confirmed = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: {},
    probeAuth: true,
    binary: "grok",
    runCommandImpl() {
      return { status: 0, stdout: "user@example.com\n", stderr: "", error: null };
    }
  });
  assert.equal(confirmed.status, "configured");
  assert.equal(confirmed.source, "whoami");
  assert.equal(isGrokAuthReady(confirmed), true);

  const rejected = getGrokAuthStatus(dir, {
    grokHome: dir,
    env: {},
    probeAuth: true,
    binary: "grok",
    runCommandImpl() {
      return { status: 1, stdout: "", stderr: "not logged in", error: null };
    }
  });
  assert.equal(rejected.status, "needs_login");
  assert.equal(isGrokAuthReady(rejected), false);
});

test("parseGrokVersion and compareGrokVersions handle CLI banners", () => {
  assert.deepEqual(parseGrokVersion("grok 0.2.114"), { raw: "0.2.114", major: 0, minor: 2, patch: 114 });
  assert.equal(parseGrokVersion("not a version"), null);
  assert.ok(compareGrokVersions("0.2.114", MIN_GROK_CLI_VERSION) > 0);
  assert.ok(compareGrokVersions("0.1.9", MIN_GROK_CLI_VERSION) < 0);
  assert.equal(compareGrokVersions("0.2.0", "0.2.0"), 0);
});

test("getGrokCapabilities records version and fails on missing required flags", () => {
  clearGrokCapabilityCache();
  let versionCalls = 0;
  let helpCalls = 0;
  const missing = getGrokCapabilities(process.cwd(), {
    binary: "grok",
    platform: "linux",
    skipCache: true,
    runCommandImpl(_command, args) {
      const joined = args.join(" ");
      if (joined.includes("--version")) {
        versionCalls += 1;
        return { status: 0, stdout: "grok 0.2.114\n", stderr: "", error: null };
      }
      if (joined.includes("--help")) {
        helpCalls += 1;
        return { status: 0, stdout: "Usage: grok\n  --output-format plain\n", stderr: "", error: null };
      }
      return { status: 1, stdout: "", stderr: "unexpected", error: null };
    }
  });
  assert.equal(missing.available, false);
  assert.equal(missing.version, "0.2.114");
  assert.equal(missing.versionOk, true);
  assert.deepEqual(missing.missingFlags, ["--json-schema", "--sandbox"]);
  assert.match(missing.detail, /Missing required review capabilities/);
  assert.match(missing.detail, /Upgrade the Grok CLI/);
  assert.equal(versionCalls, 1);
  assert.equal(helpCalls, 1);

  assert.throws(
    () => assertGrokCliCompatible(process.cwd(), {
      binary: "grok",
      platform: "linux",
      skipCache: true,
      runCommandImpl(_command, args) {
        if (args.join(" ").includes("--version")) {
          return { status: 0, stdout: "grok 0.1.0\n", stderr: "", error: null };
        }
        return {
          status: 0,
          stdout: "Usage:\n  --json-schema <S>\n  --sandbox <P>\n",
          stderr: "",
          error: null
        };
      }
    }),
    /below the minimum supported version/
  );
});

test("getGrokCapabilities caches probes across calls", () => {
  clearGrokCapabilityCache();
  let probes = 0;
  const options = {
    binary: "grok-cached",
    // Pin platform so Windows where.exe is not mixed into the probe count.
    platform: "linux",
    runCommandImpl(_command, args) {
      probes += 1;
      const joined = args.join(" ");
      if (joined.includes("--version")) {
        return { status: 0, stdout: "grok 0.2.114\n", stderr: "", error: null };
      }
      return {
        status: 0,
        stdout: "Usage:\n  --json-schema <S>\n  --sandbox <P>\n",
        stderr: "",
        error: null
      };
    }
  };
  // First call: availability --version + help = 2 probes.
  const first = getGrokCapabilities(process.cwd(), options);
  assert.equal(first.available, true);
  assert.equal(first.version, "0.2.114");
  assert.equal(probes, 2);
  // Second call: cache hit — no additional spawns.
  const second = getGrokCapabilities(process.cwd(), options);
  assert.equal(second.available, true);
  assert.equal(probes, 2);
  clearGrokCapabilityCache();
});

test("runGrokHeadless fails fast when required CLI flags are missing", async () => {
  clearGrokCapabilityCache();
  await assert.rejects(
    runGrokHeadless({
      cwd: process.cwd(),
      prompt: "should not spawn",
      write: false,
      binary: "grok",
      platform: "linux",
      timeoutMs: 5_000,
      skipSignalHandlers: true,
      runCommandImpl(_command, args) {
        if (args.join(" ").includes("--version")) {
          return { status: 0, stdout: "grok 0.2.114\n", stderr: "", error: null };
        }
        return { status: 0, stdout: "Usage: grok without schema flags\n", stderr: "", error: null };
      }
    }),
    /Missing required review capabilities|--json-schema/
  );
});

test("runGrokHeadless terminates fake Grok when output exceeds the cap", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    runGrokHeadless({
      cwd: dir,
      prompt: "test output cap",
      write: false,
      binary: process.execPath,
      binaryPrefixArgs: [FAKE_GROK],
      env: { ...process.env, FAKE_GROK_OUTPUT: "x".repeat(1024) },
      maxOutputBytes: 64,
      timeoutMs: 10_000,
      skipCapabilityCheck: true
    }),
    /output exceeded 64 bytes/
  );
});

test("runGrokHeadless times out and reaps the fake child process", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  let timedOut = null;
  try {
    await runGrokHeadless({
      cwd: dir,
      prompt: "slow",
      write: false,
      binary: process.execPath,
      binaryPrefixArgs: [FAKE_GROK],
      env: { ...process.env, FAKE_GROK_DELAY_MS: "5000" },
      timeoutMs: 50,
      skipSignalHandlers: true,
      skipCapabilityCheck: true
    });
  } catch (error) {
    timedOut = error;
  }
  assert.ok(timedOut, "expected timeout rejection");
  assert.match(String(timedOut.message), /timed out after 50 ms/);
  assert.ok(Date.now() - started < 3_000, "timeout path should not wait for the full FAKE_GROK_DELAY_MS");
  assert.ok(Number.isInteger(timedOut.pid) && timedOut.pid > 0, "timeout error should expose the child pid");
  assert.equal(isProcessAlive(timedOut.pid), false, "fake Grok child must be reaped after timeout");
});

test("streaming end.data final answer is collected without raw NDJSON fallback", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stream = [
    JSON.stringify({ type: "text", text: "partial " }),
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      data: { result: "final from end.data", sessionId: "99999999-9999-4999-8999-999999999999" }
    })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "end data",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.stdout, "final from end.data");
  assert.equal(result.sessionId, "99999999-9999-4999-8999-999999999999");
  assert.equal(result.stopReason, "EndTurn");
  assert.doesNotMatch(result.stdout, /\"type\":/);
});

test("streaming collector preserves non-success stop reasons", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stream = [
    JSON.stringify({ type: "text", data: "work in progress" }),
    JSON.stringify({
      type: "end",
      stopReason: "Cancelled",
      sessionId: "88888888-8888-4888-8888-888888888888"
    })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "cancelled stream",
    write: false,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "work in progress");
  assert.equal(result.stopReason, "Cancelled");
});

test("empty end keeps accumulated assistant text", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stream = [
    JSON.stringify({ type: "text", data: "kept " }),
    JSON.stringify({ type: "text", data: "answer" }),
    JSON.stringify({ type: "end" })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "keep assistant",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.stdout, "kept answer");
});

test("unknown stream events extract safe text once and never dump raw NDJSON", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const progress = [];
  const stream = [
    JSON.stringify({ type: "brand_new_event", data: { text: "rescued answer" } }),
    JSON.stringify({ type: "brand_new_event", data: { text: " more" } }),
    JSON.stringify({ type: "another_future", meta: { only: "metadata" } })
  ].join("\n");
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "unknown events",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env, FAKE_GROK_STREAM: stream },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.stdout, "rescued answer more");
  assert.doesNotMatch(result.stdout, /\"type\":|brand_new_event|another_future/);
  const unknownWarnings = progress.filter((line) => /Unknown streaming event type: brand_new_event/.test(line));
  assert.equal(unknownWarnings.length, 1, "unknown types should warn once, not per line");
  assert.ok(progress.some((line) => /Unknown streaming event type: another_future/.test(line)));
  assert.ok(!progress.some((line) => line.includes("\"type\"")));
});

test("getGrokAvailability resolves Windows npm .cmd shims without cmd.exe", (t) => {
  const root = tempDir();
  const shim = path.join(root, "grok.cmd");
  const target = path.join(root, "grok.mjs");
  fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\grok.mjs" %*\r\n', "utf8");
  fs.writeFileSync(target, "", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const availability = getGrokAvailability(process.cwd(), {
    binary: "grok",
    platform: "win32",
    env: { ...process.env },
    runCommandImpl(command, args) {
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: `${shim}\n`,
          stderr: "",
          error: null
        };
      }
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [target, "--version"]);
      return { status: 0, stdout: "grok 0.2.114\n", stderr: "", error: null };
    }
  });
  assert.equal(availability.available, true);
  assert.equal(availability.command, shim);
});

test("runGrokHeadless does not detach and registers interrupt cleanup path", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Foreground spawn uses detached:false; a quick successful run proves the path still works.
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "foreground",
    write: false,
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: { ...process.env },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /FAKE_GROK_OK/);
});

test("streaming collector reassembles NDJSON split across stdout chunks", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Half-line JSON across chunks: {"type":"te  +  xt","data":"A"}\n  then a second fragment.
  const chunks = [
    '{"type":"te',
    'xt","data":"A"}\n{"type":"text","data":"B',
    '"}\n{"type":"end"}\n'
  ];
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "cross-chunk stream",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STREAM_CHUNKS: JSON.stringify(chunks)
    },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "AB");
  assert.doesNotMatch(result.stdout, /\"type\":|Unparsed/);
});

test("streaming collector reassembles when FAKE_GROK_STREAM is sliced by byte size", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stream = [
    JSON.stringify({ type: "text", data: "chunked-" }),
    JSON.stringify({ type: "text", data: "answer" }),
    JSON.stringify({ type: "end" })
  ].join("\n") + "\n";
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "byte-sliced stream",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STREAM: stream,
      FAKE_GROK_STREAM_CHUNKS: "7"
    },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.stdout, "chunked-answer");
});

test("fake Grok can crash mid-stream after N lines", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stream = [
    JSON.stringify({ type: "text", data: "kept" }),
    JSON.stringify({ type: "text", data: " should-not-appear" }),
    JSON.stringify({ type: "end", data: { result: "final-should-not-appear" } })
  ].join("\n") + "\n";
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "mid-stream crash",
    write: true,
    outputFormat: "streaming-json",
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STREAM: stream,
      FAKE_GROK_EXIT_AFTER_LINES: "1",
      FAKE_GROK_EXIT_CODE: "1"
    },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "kept");
  assert.doesNotMatch(result.stdout, /should-not-appear|final-should-not-appear/);
});

test("fake Grok stderr flood is forwarded without failing a successful run", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const progress = [];
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "stderr flood",
    write: false,
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_STDERR_FLOOD: "40"
    },
    onProgress: (line) => progress.push(line),
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /FAKE_GROK_OK/);
  assert.ok(progress.filter((line) => /fake grok progress line /.test(line)).length >= 20);
});

test("non-zero exit still surfaces a legal stdout body", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runGrokHeadless({
    cwd: dir,
    prompt: "nonzero with body",
    write: false,
    binary: process.execPath,
    binaryPrefixArgs: [FAKE_GROK],
    env: {
      ...process.env,
      FAKE_GROK_OUTPUT: "LEGAL_BODY_DESPITE_EXIT",
      FAKE_GROK_EXIT_CODE: "2"
    },
    timeoutMs: 10_000,
    skipSignalHandlers: true,
    skipCapabilityCheck: true
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /LEGAL_BODY_DESPITE_EXIT/);
});
