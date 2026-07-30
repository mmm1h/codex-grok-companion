#!/usr/bin/env node

import { upsertJob } from "../plugins/grok-companion/scripts/lib/state.mjs";

const [workspace, jobId] = process.argv.slice(2);
upsertJob(workspace, {
  id: jobId,
  kind: "task",
  status: "completed",
  summary: jobId
});
