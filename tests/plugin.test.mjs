import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./helpers.mjs";

const PLUGIN_NAME = "grok-companion";
const pluginRoot = path.join(ROOT, "plugins", PLUGIN_NAME);
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(ROOT, ".agents", "plugins", "marketplace.json");

function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("plugin manifest, package, and marketplace stay aligned", () => {
  const manifest = json(manifestPath);
  const marketplace = json(marketplacePath);
  const packageJson = json(path.join(ROOT, "package.json"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === PLUGIN_NAME);

  assert.equal(path.basename(pluginRoot), manifest.name);
  assert.equal(manifest.name, PLUGIN_NAME);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(marketplace.name, "codex-grok-companion");
  assert.ok(entry);
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./plugins/grok-companion");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
});

test("all bundled skills have complete metadata and UI prompts", () => {
  const skillsRoot = path.join(pluginRoot, "skills");
  const skillNames = fs.readdirSync(skillsRoot)
    .filter((name) => fs.statSync(path.join(skillsRoot, name)).isDirectory())
    .sort();

  assert.deepEqual(skillNames, [
    "grok-adversarial-review",
    "grok-delegate",
    "grok-jobs",
    "grok-review",
    "grok-setup"
  ]);

  for (const name of skillNames) {
    const skill = fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    const ui = fs.readFileSync(path.join(skillsRoot, name, "agents", "openai.yaml"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, "m"));
    assert.match(skill, /\ndescription: .+\n---/s);
    assert.doesNotMatch(skill, /\[TODO:/);
    assert.match(ui, new RegExp(`\\$${name}\\b`));
  }
});

test("declared plugin paths and public metadata are valid", () => {
  const manifest = json(manifestPath);
  assert.ok(fs.statSync(path.join(pluginRoot, manifest.skills)).isDirectory());
  assert.match(manifest.homepage, /^https:\/\//);
  assert.match(manifest.repository, /^https:\/\//);
  assert.match(manifest.interface.websiteURL, /^https:\/\//);
  assert.ok(manifest.interface.displayName.length <= 30);
  assert.ok(manifest.interface.shortDescription.length <= 30);
  assert.match(manifest.interface.privacyPolicyURL, /^https:\/\//);
  assert.match(manifest.interface.termsOfServiceURL, /^https:\/\//);
  assert.match(manifest.interface.supportURL, /^https:\/\//);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  assert.ok(manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128));
  for (const asset of [manifest.interface.logo, manifest.interface.composerIcon]) {
    assert.match(asset, /^\.\/assets\/.+\.svg$/);
    assert.ok(fs.statSync(path.join(pluginRoot, asset)).isFile());
  }
  for (const legalFile of ["PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]) {
    assert.ok(fs.statSync(path.join(pluginRoot, legalFile)).isFile());
  }
});

test("all bundled skills are limited to Codex", () => {
  const skillRoot = path.join(pluginRoot, "skills");
  for (const name of fs.readdirSync(skillRoot)) {
    const metadata = fs.readFileSync(path.join(skillRoot, name, "agents", "openai.yaml"), "utf8");
    assert.match(metadata, /policy:\s*\r?\n\s+products:\s*\r?\n\s+- CODEX\s*$/);
    assert.doesNotMatch(metadata, /-\s+CHAT\b/);
  }
});
