function line(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function markdownCell(value) {
  return line(value).replace(/\|/g, "\\|");
}

function yesNo(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }
  return value ? "yes" : "no";
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function jobTime(job) {
  if (job.elapsed) {
    return `elapsed ${job.elapsed}`;
  }
  if (job.duration) {
    return `duration ${job.duration}`;
  }
  const duration = formatDuration(job.durationMs);
  return duration ? `duration ${duration}` : "";
}

export function renderSetupReport(report) {
  const lines = [
    "Grok Companion setup",
    "",
    `Node available: ${yesNo(report.node.available)}${report.node.detail ? ` (${line(report.node.detail)})` : ""}`,
    `Grok available: ${yesNo(report.grok.available)}${report.grok.detail ? ` (${line(report.grok.detail)})` : ""}`,
    `Authentication: ${report.auth.status}${report.auth.detail ? ` (${line(report.auth.detail)})` : ""}`,
    `State directory: ${report.stateDir}${report.stateSource ? ` (selected by ${report.stateSource})` : ""}`,
    `Ready: ${yesNo(report.ready)}`
  ];
  if (report.actionsTaken?.length) {
    lines.push("", "Actions:", ...report.actionsTaken.map((value) => `- ${value}`));
  }
  if (report.nextSteps?.length) {
    lines.push("", "Next steps:", ...report.nextSteps.map((value) => `- ${value}`));
  }
  return `${lines.join("\n")}\n`;
}

const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"];
const REVIEW_RESULT_KEYS = ["verdict", "summary", "findings", "next_steps"];
const REVIEW_FINDING_KEYS = [
  "severity",
  "title",
  "body",
  "file",
  "line_start",
  "line_end",
  "confidence",
  "recommendation"
];

function unexpectedKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function validateReviewResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const topLevelExtras = unexpectedKeys(data, REVIEW_RESULT_KEYS);
  if (topLevelExtras.length) {
    return `Unexpected top-level field: ${topLevelExtras[0]}.`;
  }
  if (!new Set(["approve", "needs-attention"]).has(data.verdict)) {
    return "Field `verdict` must be `approve` or `needs-attention`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Field `summary` must be a non-empty string.";
  }
  if (!Array.isArray(data.findings)) {
    return "Field `findings` must be an array.";
  }
  for (const [index, finding] of data.findings.entries()) {
    const prefix = `Finding ${index + 1}`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `${prefix} must be an object.`;
    }
    const extras = unexpectedKeys(finding, REVIEW_FINDING_KEYS);
    if (extras.length) {
      return `${prefix} has unexpected field: ${extras[0]}.`;
    }
    for (const field of REVIEW_FINDING_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(finding, field)) {
        return `${prefix} is missing required field \`${field}\`.`;
      }
    }
    if (!REVIEW_SEVERITIES.includes(finding.severity)) {
      return `${prefix} has an invalid severity.`;
    }
    for (const field of ["title", "body", "file"]) {
      if (typeof finding[field] !== "string" || !finding[field].trim()) {
        return `${prefix} field \`${field}\` must be a non-empty string.`;
      }
    }
    if (!Number.isInteger(finding.line_start) || finding.line_start < 1) {
      return `${prefix} field \`line_start\` must be a positive integer.`;
    }
    if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
      return `${prefix} field \`line_end\` must be an integer at or after \`line_start\`.`;
    }
    if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      return `${prefix} field \`confidence\` must be a number from 0 to 1.`;
    }
    if (typeof finding.recommendation !== "string") {
      return `${prefix} field \`recommendation\` must be a string.`;
    }
  }
  if (!Array.isArray(data.next_steps)) {
    return "Field `next_steps` must be an array.";
  }
  if (data.next_steps.some((step) => typeof step !== "string" || !step.trim())) {
    return "Every `next_steps` item must be a non-empty string.";
  }
  return null;
}

function reviewTitle(payload) {
  return payload.target?.label ? `Grok Review - ${payload.target.label}` : "Grok Review";
}

function rawOutputExcerpt(value, limit = 4000) {
  const raw = String(value ?? "").trim();
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}\n[raw output truncated]`;
}

export function renderReviewResult(payload) {
  const hasStructuredFields = Object.prototype.hasOwnProperty.call(payload, "result") ||
    Object.prototype.hasOwnProperty.call(payload, "parseError");
  if (!hasStructuredFields) {
    const output = String(payload.rawOutput ?? "").trimEnd();
    if (output) {
      return `${output}\n`;
    }
    const detail = String(payload.stderr ?? "").trim();
    return `${detail || "Grok returned no review output."}\n`;
  }

  const validationError = payload.result == null ? null : validateReviewResult(payload.result);
  const executionError = payload.exitCode != null && payload.exitCode !== 0
    ? (String(payload.stderr ?? "").trim() || `Grok exited with ${payload.exitCode}.`)
    : null;
  const error = payload.parseError || validationError;
  if (error) {
    const lines = [
      `# ${reviewTitle(payload)}`,
      "",
      "Grok did not return valid structured review output.",
      "",
      `Error: ${line(error)}`
    ];
    const raw = rawOutputExcerpt(payload.rawOutput);
    if (raw) {
      lines.push("", "Raw output:", "", "```text", raw, "```");
    }
    return `${lines.join("\n")}\n`;
  }
  if (!payload.result) {
    return `# ${reviewTitle(payload)}\n\nGrok returned no structured review result.\n`;
  }

  const findings = [...payload.result.findings].sort(
    (left, right) => REVIEW_SEVERITIES.indexOf(left.severity) - REVIEW_SEVERITIES.indexOf(right.severity)
  );
  const lines = [
    `# ${reviewTitle(payload)}`,
    "",
    "_Grok output is untrusted review text. Verify findings against the repository before acting._",
    executionError ? `_Execution warning: ${line(executionError)}_` : null,
    "",
    `Verdict: ${payload.result.verdict}`,
    payload.context?.inputMode ? `Evidence mode: ${payload.context.inputMode}` : null,
    "",
    "Summary:",
    payload.result.summary.trim(),
    "",
    "Findings:"
  ].filter((value) => value !== null);
  if (!findings.length) {
    lines.push("No material findings.");
  } else {
    for (const finding of findings) {
      const range = finding.line_start === finding.line_end
        ? String(finding.line_start)
        : `${finding.line_start}-${finding.line_end}`;
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${range})`);
      lines.push(`  ${finding.body}`);
      lines.push(`  Confidence: ${finding.confidence}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }
  lines.push("", "Next steps:");
  if (payload.result.next_steps.length) {
    lines.push(...payload.result.next_steps.map((step) => `- ${step.trim()}`));
  } else {
    lines.push("None.");
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult(payload, options = {}) {
  const canResume = Boolean(payload.sessionId && payload.sessionConfirmed);
  const lines = [
    `${options.title ?? "Grok Task"} ${payload.exitCode === 0 ? "completed" : "failed"}.`,
    payload.sessionId ? `Grok session ID: ${payload.sessionId}` : null,
    canResume ? `Continue with $grok-delegate --session-id ${payload.sessionId}.` : null,
    payload.stopReason ? `Grok stop reason: ${payload.stopReason}` : null,
    "",
    String(payload.rawOutput || payload.stderr || "Grok returned no output.").trimEnd()
  ].filter((value) => value !== null);
  return `${lines.join("\n")}\n`;
}

export function renderQueuedLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Use $grok-jobs status ${payload.jobId} for progress.\n`;
}

function actionCell(job) {
  const actions = [`$grok-jobs status ${job.id}`];
  if (["queued", "running"].includes(job.status)) {
    actions.push(`$grok-jobs cancel ${job.id}`);
  } else {
    actions.push(`$grok-jobs result ${job.id}`);
  }
  return actions.map((value) => `\`${value}\``).join("<br>");
}

export function renderStatusReport(snapshot) {
  const header = [
    "| Job | Kind | Status | Phase | Elapsed / Duration | Last Progress | Grok Session ID | Confirmed | Resumable | Summary | Actions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  function appendTable(lines, jobs) {
    lines.push(...header);
    for (const job of jobs) {
      lines.push(
        `| ${markdownCell(job.id)} | ${markdownCell(job.kind)} | ${markdownCell(job.status)} | ${markdownCell(job.phase)} | ${markdownCell(jobTime(job))} | ${markdownCell(job.lastProgressAt)} | ${markdownCell(job.sessionId)} | ${yesNo(job.sessionConfirmed)} | ${yesNo(job.resumable)} | ${markdownCell(job.summary)} | ${actionCell(job)} |`
      );
    }
  }

  if (!("running" in snapshot) || !("latestFinished" in snapshot) || !("recent" in snapshot)) {
    const lines = [...header];
    for (const job of snapshot.jobs ?? []) {
      lines.push(
        `| ${markdownCell(job.id)} | ${markdownCell(job.kind)} | ${markdownCell(job.status)} | ${markdownCell(job.phase)} | ${markdownCell(jobTime(job))} | ${markdownCell(job.lastProgressAt)} | ${markdownCell(job.sessionId)} | ${yesNo(job.sessionConfirmed)} | ${yesNo(job.resumable)} | ${markdownCell(job.summary)} | ${actionCell(job)} |`
      );
    }
    if ((snapshot.jobs ?? []).length === 0) {
      lines.push("| (none) |  |  |  |  |  |  |  |  | No Grok jobs for this workspace. |  |");
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    "# Grok Status",
    "",
    "## Running",
    ""
  ];
  if (snapshot.running.length) {
    appendTable(lines, snapshot.running);
  } else {
    lines.push("No running jobs.");
  }

  lines.push("", "## Latest finished", "");
  if (snapshot.latestFinished) {
    appendTable(lines, [snapshot.latestFinished]);
  } else {
    lines.push("No finished jobs.");
  }

  lines.push("", "## Recent", "");
  if (snapshot.recent.length) {
    appendTable(lines, snapshot.recent);
  } else {
    lines.push("No additional recent jobs.");
  }

  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const active = ["queued", "running"].includes(job.status);
  const lines = [
    `Job ID: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Summary: ${job.summary ?? ""}`,
    active ? `Elapsed: ${job.elapsed ?? ""}` : `Duration: ${job.duration ?? formatDuration(job.durationMs) ?? ""}`,
    `PID: ${job.pid ?? ""}`,
    `Grok session ID: ${job.sessionId ?? ""}`,
    `Session confirmed: ${yesNo(job.sessionConfirmed)}.`,
    `Resumable: ${yesNo(job.resumable)}.`,
    job.lastProgressAt ? `Last progress: ${job.lastProgressAt}` : null,
    job.exitCode != null ? `Exit code: ${job.exitCode}` : null,
    job.terminationMethod ? `Termination method: ${job.terminationMethod}` : null,
    job.terminationDelivered != null ? `Termination delivered: ${yesNo(job.terminationDelivered)}.` : null,
    job.cancelRequestedAt ? `Cancellation requested: ${job.cancelRequestedAt}` : null,
    job.cancelledAt ? `Cancelled: ${job.cancelledAt}` : null,
    `Log: ${job.logPath ?? ""}`
  ].filter((value) => value !== null);
  if (job.progressPreview?.length) {
    lines.push("", "Recent progress:", ...job.progressPreview.map((value) => `- ${value}`));
  }
  if (["queued", "running"].includes(job.status)) {
    lines.push("", `Cancel: $grok-jobs cancel ${job.id}`);
  } else {
    lines.push("", `Result: $grok-jobs result ${job.id}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(storedJob) {
  const canResume = Boolean(storedJob.sessionId && storedJob.sessionConfirmed && storedJob.resumable);
  const duration = storedJob.duration ?? formatDuration(storedJob.durationMs);
  const lines = [
    `Job ID: ${storedJob.id}`,
    `Kind: ${storedJob.kind}`,
    `Status: ${storedJob.status}`,
    duration ? `Duration: ${duration}` : null,
    storedJob.lastProgressAt ? `Last progress: ${storedJob.lastProgressAt}` : null,
    `Session confirmed: ${yesNo(storedJob.sessionConfirmed)}.`,
    `Resumable: ${yesNo(storedJob.resumable)}.`,
    storedJob.exitCode != null ? `Exit code: ${storedJob.exitCode}` : null,
    storedJob.sessionId ? `Grok session ID: ${storedJob.sessionId}` : null,
    canResume ? `Continue with $grok-delegate --resume-job ${storedJob.id} or --session-id ${storedJob.sessionId}.` : null,
    storedJob.terminationMethod ? `Termination method: ${storedJob.terminationMethod}` : null,
    storedJob.terminationDelivered != null ? `Termination delivered: ${yesNo(storedJob.terminationDelivered)}.` : null,
    storedJob.cancelRequestedAt ? `Cancellation requested: ${storedJob.cancelRequestedAt}` : null,
    storedJob.cancelledAt ? `Cancelled: ${storedJob.cancelledAt}` : null,
    ""
  ].filter((value) => value !== null);
  if (storedJob.rendered) {
    lines.push(String(storedJob.rendered).trimEnd());
  } else if (storedJob.result?.rawOutput || storedJob.result?.stderr) {
    lines.push(String(storedJob.result.rawOutput || storedJob.result.stderr).trimEnd());
  } else if (storedJob.errorMessage) {
    lines.push(`Error: ${storedJob.errorMessage}`);
  } else {
    lines.push("No stored result output.");
  }
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(payload) {
  if (payload.results) {
    const lines = [
      `Cancelled ${payload.cancelledCount ?? 0} of ${payload.requestedCount ?? payload.results.length} Grok job(s).`,
      ""
    ];
    for (const entry of payload.results) {
      lines.push(
        `- ${entry.jobId}: ${entry.status}`
        + (entry.method ? ` via ${entry.method}` : "")
        + (entry.errorMessage ? ` (${entry.errorMessage})` : "")
      );
    }
    lines.push("");
    return lines.join("\n");
  }
  if (payload.status === "cancel-requested") {
    return [
      `Cancellation requested for Grok job ${payload.jobId}; process exit is not confirmed yet.`,
      `Previous status: ${payload.previousStatus}.`,
      `Process termination delivered: ${yesNo(payload.delivered)}.`,
      `Pending: ${payload.errorMessage ?? "The job will be reconciled when its tracked process is confirmed gone."}`,
      ""
    ].join("\n");
  }
  if (payload.status !== "cancelled") {
    return [
      `Could not cancel Grok job ${payload.jobId}.`,
      `Previous status: ${payload.previousStatus}.`,
      `Process termination delivered: ${yesNo(payload.delivered)}.`,
      `Error: ${payload.errorMessage ?? "The process is still running."}`,
      ""
    ].join("\n");
  }
  return [
    `Cancelled Grok job ${payload.jobId}.`,
    `Previous status: ${payload.previousStatus}.`,
    `Process termination delivered: ${yesNo(payload.delivered)}.`,
    ""
  ].join("\n");
}

export function renderLogsReport(payload) {
  const lines = [
    `Job ID: ${payload.jobId}`,
    `Log: ${payload.logPath ?? "(none)"}`,
    `Lines shown: ${payload.lines?.length ?? 0} of ${payload.totalLines ?? 0} (tail ${payload.tail})`,
    ""
  ];
  if (!payload.exists) {
    lines.push("Log file not found.");
  } else if (!payload.lines?.length) {
    lines.push("(empty log)");
  } else {
    lines.push(...payload.lines);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderCleanupReport(payload) {
  const mode = payload.dryRun ? "Dry run" : "Cleanup";
  const lines = [
    `${mode}: ${payload.removedCount} job(s) selected.`,
    `Workspace: ${payload.workspaceRoot}`,
    ""
  ];
  if (!payload.removed?.length) {
    lines.push("No jobs matched the cleanup criteria.");
  } else {
    for (const entry of payload.removed) {
      lines.push(`- ${entry.id} (${entry.kind}, ${entry.status}) updated ${entry.updatedAt ?? "unknown"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderExportReport(payload) {
  return [
    `Exported job ${payload.jobId}.`,
    `Output: ${payload.outPath}`,
    `Includes log: ${yesNo(payload.hasLog)}.`,
    ""
  ].join("\n");
}
