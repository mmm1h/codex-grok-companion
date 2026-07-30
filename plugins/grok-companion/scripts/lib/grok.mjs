import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createTempDir } from "./fs.mjs";
import { binaryAvailable, resolveSpawnInvocation, runCommand, terminateProcessTree } from "./process.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const INLINE_PROMPT_MAX_BYTES = 6 * 1024;
const READ_ONLY_TOOLS = "read_file,grep,list_dir";
/** Lowest Grok CLI version known to expose the flags companion hard-codes. */
export const MIN_GROK_CLI_VERSION = "0.2.0";
const REQUIRED_REVIEW_FLAGS = ["--json-schema", "--sandbox"];
const capabilityCache = new Map();

function grokBinary(options = {}) {
  return options.binary ?? process.env.GROK_COMPANION_GROK_BINARY ?? "grok";
}
function grokPrefixArgs(options = {}) {
  if (options.binaryPrefixArgs) {
    return options.binaryPrefixArgs;
  }
  const raw = options.env?.GROK_COMPANION_GROK_PREFIX_ARGS ?? process.env.GROK_COMPANION_GROK_PREFIX_ARGS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    throw new Error("GROK_COMPANION_GROK_PREFIX_ARGS must be a JSON array.");
  }
}

function capabilityCacheKey(cwd, options = {}) {
  const binary = grokBinary(options);
  const prefix = JSON.stringify(grokPrefixArgs(options));
  return `${binary}\0${prefix}\0${path.resolve(cwd ?? process.cwd())}`;
}

/** Clear the in-process version/capabilities cache (tests and long-lived hosts). */
export function clearGrokCapabilityCache() {
  capabilityCache.clear();
}

/**
 * Parse a Grok CLI version string (e.g. "grok 0.2.114") into comparable parts.
 * Returns null when no semver triplet is present.
 */
export function parseGrokVersion(text) {
  const match = String(text ?? "").match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) {
    return null;
  }
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

/** Compare two semver strings or parsed objects. Negative if left < right. */
export function compareGrokVersions(left, right) {
  const a = typeof left === "string" ? parseGrokVersion(left) : left;
  const b = typeof right === "string" ? parseGrokVersion(right) : right;
  if (!a || !b) {
    return null;
  }
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

function stripAnsi(text) {
  // CSI / OSC sequences commonly used by CLI help colorization.
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function helpMentionsFlag(help, flag) {
  const plain = stripAnsi(help);
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow optional ANSI remnants and accept value markers ("<", "=") or end-of-token.
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|[=<]|$)`, "m").test(plain);
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = grokBinary(options);
  const availability = binaryAvailable(binary, ["--version"], {
    cwd,
    env: options.env,
    platform: options.platform,
    runCommandImpl: options.runCommandImpl
  });
  const version = parseGrokVersion(availability.detail);
  return {
    command: availability.command ?? binary,
    ...availability,
    version: version?.raw ?? null
  };
}

export function getGrokCapabilities(cwd, options = {}) {
  const key = capabilityCacheKey(cwd, options);
  if (!options.skipCache && capabilityCache.has(key)) {
    return capabilityCache.get(key);
  }

  const binary = grokBinary(options);
  const run = options.runCommandImpl ?? runCommand;
  const prefix = grokPrefixArgs(options);

  // Reuse the same --version path as getGrokAvailability (no prefix fixture).
  // A separate `prefix + --version` spawn would execute fixture scripts and side-effect
  // (e.g. FAKE_GROK_CAPTURE) during setup, breaking short-circuit tests.
  const availability = options.availability ?? getGrokAvailability(cwd, options);
  const version = parseGrokVersion(availability.detail);
  const versionOk = version
    ? (compareGrokVersions(version, MIN_GROK_CLI_VERSION) ?? 0) >= 0
    : null;

  const helpArgs = [...prefix, "--help"];
  const invocation = resolveSpawnInvocation(binary, helpArgs, {
    cwd,
    env: options.env,
    platform: options.platform,
    runCommandImpl: options.runCommandImpl
  });
  const result = run(invocation.command, invocation.args, {
    cwd,
    env: options.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
  if (result.error || result.status !== 0) {
    const payload = {
      available: false,
      jsonSchema: false,
      sandbox: false,
      version: version?.raw ?? null,
      versionOk,
      minVersion: MIN_GROK_CLI_VERSION,
      missingFlags: [...REQUIRED_REVIEW_FLAGS],
      detail: String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()
    };
    if (!options.skipCache) {
      capabilityCache.set(key, payload);
    }
    return payload;
  }
  const help = `${result.stdout}\n${result.stderr}`;
  const jsonSchema = helpMentionsFlag(help, "--json-schema");
  const sandbox = helpMentionsFlag(help, "--sandbox");
  const missingFlags = [
    !jsonSchema ? "--json-schema" : null,
    !sandbox ? "--sandbox" : null
  ].filter(Boolean);

  let detail;
  let available = missingFlags.length === 0 && versionOk !== false;
  if (missingFlags.length) {
    const versionHint = version?.raw
      ? ` Current CLI reports ${version.raw}; companion requires >= ${MIN_GROK_CLI_VERSION} with these flags.`
      : ` Companion requires Grok CLI >= ${MIN_GROK_CLI_VERSION} with these flags.`;
    detail = `Missing required review capabilities: ${missingFlags.join(", ")}.${versionHint} Upgrade the Grok CLI, or pin to a compatible release if a newer build dropped these flags.`;
  } else if (versionOk === false) {
    detail = `Grok CLI ${version.raw} is below the minimum supported version ${MIN_GROK_CLI_VERSION}. Upgrade the Grok CLI.`;
    available = false;
  } else if (version?.raw) {
    detail = `Supports structured review output and read-only sandboxing (Grok CLI ${version.raw}).`;
  } else {
    detail = "Supports structured review output and read-only sandboxing.";
  }

  const payload = {
    available,
    jsonSchema,
    sandbox,
    version: version?.raw ?? null,
    versionOk,
    minVersion: MIN_GROK_CLI_VERSION,
    missingFlags,
    detail
  };
  if (!options.skipCache) {
    capabilityCache.set(key, payload);
  }
  return payload;
}

/**
 * Fail fast when the installed CLI lacks required flags or is too old.
 * Uses the capability cache so repeated task/review calls do not re-spawn probes.
 */
export function assertGrokCliCompatible(cwd, options = {}) {
  const capabilities = getGrokCapabilities(cwd, options);
  if (!capabilities.available) {
    throw new Error(capabilities.detail || "Grok CLI is missing required capabilities.");
  }
  return capabilities;
}

function hasNonEmptyFile(file) {
  const maxEvidenceBytes = 64 * 1024;
  let descriptor = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxEvidenceBytes) {
      return false;
    }
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(stat.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, stat.size, 0);
    return buffer.toString("utf8", 0, bytesRead).trim().length > 0;
  } catch {
    return false;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isNonEmptyEnvValue(value) {
  return value != null && String(value).trim() !== "";
}

/**
 * Collect offline auth evidence from config.toml without a TOML dependency.
 *
 * Supports:
 * - model/global `env_key = "VAR"` when that env var is non-empty
 * - inline `api_key = "..."` (presence only; value never returned)
 *
 * Never includes secret values in returned objects.
 */
function authEvidenceFromConfigToml(configPath, env) {
  const text = readTextFile(configPath);
  if (text == null || text.trim() === "") {
    return null;
  }

  const envKeys = new Set();
  for (const match of text.matchAll(/^\s*env_key\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/gm)) {
    const key = match[1] ?? match[2];
    if (key && key.trim()) {
      envKeys.add(key.trim());
    }
  }
  for (const key of envKeys) {
    if (isNonEmptyEnvValue(env[key])) {
      // Only the variable name is safe to surface — never the secret value.
      return {
        status: "configured",
        loggedIn: true,
        authUnverified: false,
        source: "env",
        detail: `Credentials available via environment variable ${key} (referenced by config.toml env_key).`
      };
    }
  }

  // Inline api_key in config counts as configured; never echo the value.
  for (const match of text.matchAll(/^\s*api_key\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/gm)) {
    const value = match[1] ?? match[2] ?? "";
    if (value.trim()) {
      return {
        status: "configured",
        loggedIn: true,
        authUnverified: false,
        source: "config.toml",
        detail: "An API key is present in local Grok config.toml."
      };
    }
  }

  return null;
}

/**
 * Local, offline auth evidence only by default.
 *
 * Takeaways:
 * - API keys / credential files / config env_key with a set env var => configured.
 * - config.toml / agent_id alone => needs_login + authUnverified; does NOT count as ready
 *   (see isGrokAuthReady). Avoids setup false-green on fresh installs that never logged in.
 * - Optional probeAuth runs a lightweight `grok whoami` with timeout; default off so
 *   setup stays fast and never issues a model/paid call.
 */
export function getGrokAuthStatus(_cwd, options = {}) {
  const env = options.env ?? process.env;
  if (isNonEmptyEnvValue(env.GROK_API_KEY) || isNonEmptyEnvValue(env.XAI_API_KEY)) {
    return {
      status: "configured",
      loggedIn: true,
      authUnverified: false,
      source: isNonEmptyEnvValue(env.GROK_API_KEY) ? "GROK_API_KEY" : "XAI_API_KEY",
      detail: "An API key environment variable is present."
    };
  }

  const grokHome = options.grokHome ?? path.join(os.homedir(), ".grok");
  const credentialFiles = [
    "credentials.json",
    "auth.json",
    "oauth.json",
    "tokens.json",
    "api_key",
    "api-key"
  ].map((name) => path.join(grokHome, name));
  const credential = credentialFiles.find(hasNonEmptyFile);
  if (credential) {
    return {
      status: "configured",
      loggedIn: true,
      authUnverified: false,
      source: path.basename(credential),
      detail: "A local Grok credential file is present."
    };
  }

  const configPath = path.join(grokHome, "config.toml");
  const configPresent = hasNonEmptyFile(configPath);
  if (configPresent) {
    const fromConfig = authEvidenceFromConfigToml(configPath, env);
    if (fromConfig) {
      return fromConfig;
    }
  }

  const localIdentityPresent = hasNonEmptyFile(path.join(grokHome, "agent_id"));
  if (configPresent || localIdentityPresent) {
    const source = configPresent ? "config.toml" : "agent_id";
    // Optional lightweight probe — disabled by default (no network/model call on setup).
    if (options.probeAuth) {
      return probeGrokAuth(_cwd, options);
    }
    // config.toml / agent_id alone are not proof of login. Report needs_login so
    // setup ready formulas using `status !== "needs_login"` do not false-green.
    // authUnverified remains true so callers can tell this apart from a fully empty home.
    return {
      status: "needs_login",
      loggedIn: false,
      authUnverified: true,
      source,
      detail: "Local Grok config was found, but no credential file or API key is present. Run `grok login` before the first paid call."
    };
  }

  return {
    status: "needs_login",
    loggedIn: false,
    authUnverified: false,
    source: null,
    detail: "No local Grok authentication evidence was found. Run `grok login`."
  };
}

/**
 * Whether auth evidence is strong enough for setup "ready".
 * needs_login / unknown / authUnverified must not count as ready.
 * Prefer this over `status !== "needs_login"` (which treated unknown as ready).
 */
export function isGrokAuthReady(auth) {
  if (!auth || typeof auth !== "object") {
    return false;
  }
  if (auth.authUnverified === true) {
    return false;
  }
  return auth.status === "configured";
}

function probeGrokAuth(cwd, options = {}) {
  const binary = grokBinary(options);
  const prefix = grokPrefixArgs(options);
  const timeoutMs = options.probeAuthTimeoutMs ?? 3_000;
  const run = options.runCommandImpl ?? runCommand;
  const invocation = resolveSpawnInvocation(binary, [...prefix, "whoami"], {
    cwd,
    env: options.env,
    platform: options.platform,
    runCommandImpl: options.runCommandImpl
  });
  try {
    const result = run(invocation.command, invocation.args, {
      cwd,
      env: options.env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      timeout: timeoutMs
    });
    if (result.error || result.status !== 0) {
      return {
        status: "needs_login",
        loggedIn: false,
        authUnverified: false,
        source: "whoami",
        detail: String(result.stderr || result.stdout || result.error?.message || "grok whoami failed").trim()
          || "grok whoami failed; run `grok login`."
      };
    }
    return {
      status: "configured",
      loggedIn: true,
      authUnverified: false,
      source: "whoami",
      detail: "Confirmed via `grok whoami`."
    };
  } catch (error) {
    return {
      status: "unknown",
      loggedIn: null,
      authUnverified: true,
      source: "whoami",
      detail: `Auth probe failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function buildGrokArgs(options = {}) {
  const args = [...grokPrefixArgs(options)];
  const sessionId = options.resumeSessionId || options.sessionId || randomUUID();
  if (options.jsonSchema != null) {
    const schema = typeof options.jsonSchema === "string"
      ? options.jsonSchema
      : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schema);
  } else {
    args.push("--output-format", String(options.outputFormat ?? "plain"));
  }
  args.push("--verbatim", "--no-memory");
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.effort) {
    args.push("--reasoning-effort", String(options.effort));
  }
  if (options.resumeSessionId) {
    args.push("--resume", String(options.resumeSessionId));
  } else {
    args.push("--session-id", sessionId);
  }

  if (options.write) {
    if (options.sandbox) {
      args.push("--sandbox", String(options.sandbox));
    }
    args.push("--permission-mode", "acceptEdits", "--no-subagents");
  } else {
    args.push(
      "--sandbox",
      "read-only",
      "--permission-mode",
      "plan",
      "--tools",
      READ_ONLY_TOOLS,
      "--no-subagents",
      "--disable-web-search"
    );
  }

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else {
    args.push("-p", String(options.prompt ?? ""));
  }
  return { args, sessionId };
}

const STRUCTURED_OUTPUT_FIELDS = ["result", "message", "content", "output", "text"];
// Grok multi-turn structured runs may emit one JSON object per turn, concatenated.
// Prefer the last complete object so intermediate empty findings do not poison parse.
const KNOWN_STREAM_EVENT_TYPES =
  /^(system|init|session|tool|command|function|assistant|message|content|delta|result|final|complete|error|fail|thought|thinking|reasoning|text|end|usage)(_|$)|^(tool|command|function|assistant|message|content|delta|result|final|complete|error|fail|thought|thinking|reasoning|text|end|usage|system|init|session)/i;

function extractStructuredObject(value, depth = 0) {
  if (depth > 8) {
    throw new Error("Grok structured output envelope is nested too deeply.");
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      throw new Error("Grok structured output envelope contains an empty value.");
    }
    const values = parseConcatenatedJsonValues(text);
    return extractStructuredObject(selectPreferredStructuredValue(values), depth + 1);
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error("Grok structured output envelope must contain exactly one payload.");
    }
    return extractStructuredObject(value[0], depth + 1);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Grok structured output is not a JSON object.");
  }
  for (const field of STRUCTURED_OUTPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] != null) {
      return extractStructuredObject(value[field], depth + 1);
    }
  }
  return value;
}

/**
 * Split concatenated top-level JSON values (e.g. `{}{}` from multi-turn schema output).
 * Returns values in order; callers should prefer the last complete object.
 */
export function parseConcatenatedJsonValues(raw) {
  const text = String(raw ?? "");
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    const startChar = text[index];
    if (startChar !== "{" && startChar !== "[") {
      const nextObject = text.indexOf("{", index);
      const nextArray = text.indexOf("[", index);
      const next = [nextObject, nextArray].filter((value) => value >= 0).sort((a, b) => a - b)[0];
      if (next == null) {
        break;
      }
      index = next;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const ch = text[cursor];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end < 0) {
      break;
    }
    values.push(JSON.parse(text.slice(index, end + 1)));
    index = end + 1;
  }
  return values;
}

function selectPreferredStructuredValue(values) {
  if (!values.length) {
    throw new Error("Grok structured output did not contain a complete JSON value.");
  }
  // Prefer the last object that already looks like a review payload.
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "verdict") ||
      Object.prototype.hasOwnProperty.call(value, "decision") ||
      Object.prototype.hasOwnProperty.call(value, "findings") ||
      STRUCTURED_OUTPUT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))
    ) {
      return value;
    }
  }
  return values[values.length - 1];
}

function structuredStopReason(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return null;
  }
  const direct = value.stopReason ?? value.stop_reason;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  for (const field of STRUCTURED_OUTPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const nested = structuredStopReason(value[field], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

export function grokStopReasonError(stopReason) {
  const value = String(stopReason ?? "").trim();
  if (!value) {
    return "Grok exited without a terminal stop reason; refusing to treat partial output as success.";
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "endturn") {
    return null;
  }
  return `Grok ended without a complete result (stop reason: ${value}).`;
}

export function parseGrokStructuredOutput(stdout) {
  const raw = String(stdout ?? "");
  if (!raw.trim()) {
    return { ok: false, parseError: "Grok returned no structured output.", raw };
  }
  try {
    let root;
    try {
      root = JSON.parse(raw);
    } catch {
      const values = parseConcatenatedJsonValues(raw);
      root = selectPreferredStructuredValue(values);
    }
    // Also handle NDJSON (one object per line): take last non-empty line object.
    if (typeof root === "object" && root != null && !Array.isArray(root)) {
      // single object ok
    } else if (raw.includes("\n") && raw.trim().startsWith("{")) {
      const lineValues = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            try {
              return parseConcatenatedJsonValues(line);
            } catch {
              return [];
            }
          }
        });
      if (lineValues.length > 1) {
        root = selectPreferredStructuredValue(lineValues);
      }
    }
    // Concatenated objects that still parse as first-only is impossible with JSON.parse;
    // when raw has }{ between values, JSON.parse fails and we already split above.
    if (/\}\s*\{/.test(raw.trim())) {
      const values = parseConcatenatedJsonValues(raw);
      if (values.length > 1) {
        root = selectPreferredStructuredValue(values);
      }
    }
    const data = extractStructuredObject(root);
    return { ok: true, data, stopReason: structuredStopReason(root), raw };
  } catch (error) {
    return {
      ok: false,
      parseError: error instanceof Error ? error.message : String(error),
      raw
    };
  }
}

function progressLines(stream, onProgress) {
  if (!onProgress) {
    return;
  }
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) {
        onProgress(line.trim());
      }
    }
  });
  stream.on("end", () => {
    if (pending.trim()) {
      onProgress(pending.trim());
    }
  });
}

function parsedSessionId(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const labelled = combined.match(/(?:session(?:\s+id)?|session_id)\s*[:=]\s*([0-9a-f-]{32,36})/i);
  return labelled?.[1] ?? null;
}

function streamText(value, depth = 0) {
  if (depth > 8) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => streamText(entry, depth + 1)).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return streamText(value.content, depth + 1);
  }
  if (value.message != null) {
    return streamText(value.message, depth + 1);
  }
  if (value.delta != null) {
    return streamText(value.delta, depth + 1);
  }
  // CLI variants may nest the answer under .data (including type=end payloads).
  if (value.data != null) {
    const nested = streamText(value.data, depth + 1);
    if (nested) {
      return nested;
    }
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.output === "string") {
    return value.output;
  }
  return "";
}

function collectStreamText(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  return streamText(
    event.result
      ?? event.output
      ?? event.message
      ?? event.content
      ?? event.text
      ?? event.data
      ?? event.delta
      ?? null
  );
}

function streamSessionId(event) {
  const values = [
    event?.sessionId,
    event?.session_id,
    event?.data?.sessionId,
    event?.data?.session_id,
    event?.session?.id,
    event?.message?.sessionId,
    event?.message?.session_id
  ];
  return values.find((value) => typeof value === "string" && /^[0-9a-f-]{32,36}$/i.test(value)) ?? null;
}

function streamStopReason(event) {
  const values = [
    event?.stopReason,
    event?.stop_reason,
    event?.data?.stopReason,
    event?.data?.stop_reason,
    event?.result?.stopReason,
    event?.result?.stop_reason
  ];
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

export function normalizeGrokStreamingEvent(event, at = new Date().toISOString()) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const eventType = String(event.type ?? event.event ?? event.kind ?? "unknown");
  const normalizedType = eventType.toLowerCase();
  const sessionId = streamSessionId(event);
  const toolName = event.name ?? event.tool_name ?? event.tool?.name ?? event.message?.name ?? null;
  let phase = "running";
  // thought/text/end are emitted by Grok CLI 0.2.x streaming-json; never treat as unknown.
  if (/thought|thinking|reasoning/.test(normalizedType)) {
    phase = "reasoning";
  } else if (/tool|command|function/.test(normalizedType)) {
    phase = "tool";
  } else if (/assistant|message|content|delta|^text$/.test(normalizedType)) {
    phase = "assistant";
  } else if (/result|final|complete|^end$/.test(normalizedType)) {
    phase = "finalizing";
  } else if (/error|fail/.test(normalizedType)) {
    phase = "failed";
  } else if (/usage|system|init|session/.test(normalizedType)) {
    phase = "running";
  }

  let message = "";
  if (/thought|thinking|reasoning/.test(normalizedType)) {
    // Suppress token-level reasoning from progress streams.
    message = "";
  } else if (toolName) {
    message = `Grok tool: ${toolName}`;
  } else if (typeof event.message === "string") {
    message = event.message;
  } else if (typeof event.error === "string") {
    message = event.error;
  } else if (sessionId) {
    message = `Grok session confirmed: ${sessionId}`;
  } else if (/^text$/.test(normalizedType)) {
    // Accumulate text via collector; keep progress quiet.
    message = "";
  } else if (/^end$|^usage$/.test(normalizedType)) {
    message = "";
  } else {
    message = streamText(event.message ?? event.delta ?? event.content ?? event.result ?? event.output);
  }

  return {
    message: String(message).trim().replace(/\s+/g, " ").slice(0, 500),
    phase,
    sessionId,
    eventType,
    at,
    suppressProgress: /thought|thinking|reasoning|^text$|^end$|^usage$/.test(normalizedType)
  };
}

function createStreamingCollector(options = {}) {
  let pending = "";
  let observedSessionId = null;
  let stopReason = null;
  const finalTexts = [];
  const assistantTexts = [];
  const warnedUnknownTypes = new Set();
  let warnedUnknownFallback = false;

  const acceptLine = (line) => {
    const raw = String(line).trim();
    if (!raw) {
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      options.onProgress?.(`Unparsed streaming output: ${raw}`);
      return;
    }
    const telemetry = normalizeGrokStreamingEvent(event);
    if (!telemetry) {
      // Do not forward raw event bodies — they can be huge reasoning tokens.
      options.onProgress?.("Unparsed streaming event ignored.");
      return;
    }
    observedSessionId = telemetry.sessionId ?? observedSessionId;
    options.onTelemetry?.(telemetry, event);

    const type = telemetry.eventType.toLowerCase();
    const known = KNOWN_STREAM_EVENT_TYPES.test(telemetry.eventType);

    if (/result|final|complete|^end$/.test(type)) {
      stopReason = streamStopReason(event) ?? stopReason;
      // Prefer explicit final fields (including event.data); empty end keeps assistant text.
      const finalText = collectStreamText(event);
      if (finalText.trim()) {
        finalTexts.push(finalText);
      }
    } else if (/assistant|message|content|delta|^text$/.test(type)) {
      const assistantText = streamText(
        event.data ?? event.message ?? event.delta ?? event.content ?? event.text ?? event
      );
      if (assistantText) {
        assistantTexts.push(assistantText);
      }
    } else if (!known) {
      // Future event types: extract safe text without dumping the full NDJSON line.
      const extracted = collectStreamText(event);
      if (extracted.trim()) {
        assistantTexts.push(extracted);
      }
      if (!warnedUnknownTypes.has(telemetry.eventType)) {
        warnedUnknownTypes.add(telemetry.eventType);
        options.onProgress?.(`Unknown streaming event type: ${telemetry.eventType}`);
      }
    }

    // Never echo raw unknown JSON into progress.
    // Known thought/text/end/usage events are intentionally silent in progress.
    if (known && telemetry.message && /tool|command|function|session/.test(type) && !telemetry.suppressProgress) {
      options.onProgress?.(telemetry.message);
    }
  };

  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        acceptLine(line);
      }
    },
    end() {
      acceptLine(pending);
      pending = "";
    },
    result(rawOutput) {
      const finalText = finalTexts.at(-1)?.trimEnd();
      const assistantText = assistantTexts.join("").trimEnd();
      // Prefer collected answer text. Never fall back to full raw NDJSON on stdout —
      // that pollutes the host context when only unknown event types were seen.
      if (finalText || assistantText) {
        return {
          stdout: finalText || assistantText,
          observedSessionId,
          stopReason
        };
      }
      const raw = String(rawOutput ?? "").trimEnd();
      if (raw && !warnedUnknownFallback) {
        warnedUnknownFallback = true;
        options.onProgress?.("Streaming produced no extractable answer text; suppressing raw NDJSON fallback.");
      }
      return {
        stdout: "",
        observedSessionId,
        stopReason,
        rawSuppressed: Boolean(raw)
      };
    }
  };
}

export async function runGrokHeadless(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const childEnv = options.env ?? process.env;
  // Fail fast on missing flags / too-old CLI before spending a model call.
  // Cached; skip with options.skipCapabilityCheck for tests that only exercise spawn plumbing.
  if (!options.skipCapabilityCheck) {
    assertGrokCliCompatible(cwd, options);
  }
  let tempDir = null;
  let promptFile = options.promptFile ? path.resolve(cwd, options.promptFile) : null;
  if (!promptFile && Buffer.byteLength(String(options.prompt ?? ""), "utf8") > INLINE_PROMPT_MAX_BYTES) {
    tempDir = createTempDir("grok-companion-prompt-");
    promptFile = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptFile, String(options.prompt ?? ""), "utf8");
  }

  const built = buildGrokArgs({ ...options, promptFile });
  const binary = grokBinary(options);
  // Resolve Windows npm .cmd shims without shell:true (prompt must never be shell-concatenated).
  const invocation = resolveSpawnInvocation(binary, built.args, {
    cwd,
    env: childEnv,
    platform: options.platform,
    runCommandImpl: options.runCommandImpl
  });
  const command = invocation.resolved;
  const streaming = options.outputFormat === "streaming-json"
    ? createStreamingCollector(options)
    : null;
  const startedAt = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      // Never detach the foreground Grok child: Ctrl-C / SIGTERM must reclaim it.
      // Background workers already set GROK_COMPANION_BACKGROUND_WORKER=1 and run
      // under a detached companion worker process that owns lifecycle.
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnv,
        detached: false,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      let outputBytes = 0;
      const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
      const childPids = [];

      const append = (current, chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maxOutputBytes) {
          throw new Error(`Grok output exceeded ${maxOutputBytes} bytes.`);
        }
        return current + chunk.toString();
      };
      const cleanupSignals = () => {
        if (options.skipSignalHandlers) {
          return;
        }
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onInterrupt);
      };
      const terminateChild = () => {
        try {
          terminateProcessTree(child.pid, {
            childPids,
            platform: options.platform ?? process.platform
          });
        } catch {
          // Preserve the original process or output failure.
        }
      };
      const fail = (error, terminate = true) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupSignals();
        if (timer) {
          clearTimeout(timer);
        }
        if (error && typeof error === "object" && Number.isInteger(child.pid)) {
          error.pid = child.pid;
        }
        if (terminate) {
          terminateChild();
          // Wait for the child to exit so callers can assert the process was reaped.
          const finish = () => reject(error);
          let finished = false;
          const done = () => {
            if (finished) {
              return;
            }
            finished = true;
            finish();
          };
          child.once("close", done);
          setTimeout(done, 2_000).unref?.();
          return;
        }
        reject(error);
      };
      const onInterrupt = (signal) => {
        fail(new Error(`Grok interrupted by ${signal}.`), true);
      };

      if (!options.skipSignalHandlers) {
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onInterrupt);
      }

      if (Number.isInteger(child.pid) && child.pid > 0) {
        childPids.push(child.pid);
      }

      child.stdout.on("data", (chunk) => {
        try {
          stdout = append(stdout, chunk);
          streaming?.push(chunk);
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          fail(error);
        }
      });
      progressLines(child.stderr, options.onProgress);

      timer = setTimeout(() => {
        fail(new Error(`Grok timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();

      child.once("error", (error) => {
        fail(error, false);
      });
      child.once("close", (code, signal) => {
        if (!settled) {
          settled = true;
          cleanupSignals();
          clearTimeout(timer);
          streaming?.end();
          resolve({ exitCode: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null });
        }
      });
    });
    const collected = streaming?.result(result.stdout) ?? { stdout: result.stdout, observedSessionId: null };
    const labelledSessionId = parsedSessionId(result.stdout, result.stderr);
    const observedSessionId = collected.observedSessionId ?? labelledSessionId;
    return {
      ...result,
      stdout: collected.stdout,
      rawStdout: result.stdout,
      command,
      args: built.args,
      sessionId: observedSessionId ?? built.sessionId,
      sessionConfirmed: Boolean(observedSessionId || options.sessionConfirmed),
      stopReason: collected.stopReason ?? null,
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
