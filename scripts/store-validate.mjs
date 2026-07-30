import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

function requireCondition(errors, condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pluginFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in the store bundle: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function validateHttps(errors, value, field) {
  try {
    requireCondition(errors, new URL(value).protocol === "https:", `${field} must use HTTPS.`);
  } catch {
    errors.push(`${field} must be a valid URL.`);
  }
}

function validateSvg(errors, file, field) {
  requireCondition(errors, fs.existsSync(file), `${field} file is missing: ${file}`);
  if (!fs.existsSync(file)) {
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  const root = text.match(/^\s*<svg\b([^>]*)>/i);
  requireCondition(errors, Boolean(root), `${field} must have an SVG root element.`);
  if (!root) {
    return;
  }
  const viewBox = root[1].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  requireCondition(errors, Boolean(viewBox), `${field} must define a numeric viewBox.`);
  if (!viewBox) {
    return;
  }
  const values = viewBox[1].trim().split(/\s+/).map(Number);
  requireCondition(
    errors,
    values.length === 4 && values.every(Number.isFinite),
    `${field} viewBox must contain four numbers.`
  );
  if (values.length === 4 && values.every(Number.isFinite)) {
    const [, , width, height] = values;
    requireCondition(errors, width === height, `${field} must be square.`);
    requireCondition(errors, width >= 48 && width <= 4096, `${field} dimensions must be between 48 and 4096.`);
  }
}

export function validateStore(root = ROOT) {
  const pluginRoot = path.join(root, "plugins", "grok-companion");
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const submissionPath = path.join(pluginRoot, "store", "submission.json");
  const errors = [];
  const manifest = readJson(manifestPath);
  const submission = readJson(submissionPath);
  const ui = manifest.interface ?? {};

  requireCondition(errors, manifest.name === "grok-companion", "Manifest name must be grok-companion.");
  requireCondition(
    errors,
    typeof ui.displayName === "string" && ui.displayName.length > 0 && ui.displayName.length <= 30,
    "interface.displayName must contain 1-30 characters."
  );
  requireCondition(
    errors,
    typeof ui.shortDescription === "string"
      && ui.shortDescription.length > 0
      && ui.shortDescription.length <= 30
      && !/[\r\n]/.test(ui.shortDescription),
    "interface.shortDescription must contain 1-30 characters on one line."
  );
  requireCondition(
    errors,
    Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3,
    "interface.defaultPrompt must contain 1-3 prompts."
  );
  for (const prompt of ui.defaultPrompt ?? []) {
    requireCondition(
      errors,
      typeof prompt === "string" && prompt.length > 0 && prompt.length <= 128 && !/[\r\n]/.test(prompt),
      "Every default prompt must contain 1-128 characters on one line."
    );
  }

  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) {
    validateHttps(errors, ui[field], `interface.${field}`);
  }
  for (const legalFile of ["PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]) {
    requireCondition(errors, fs.existsSync(path.join(pluginRoot, legalFile)), `${legalFile} is required.`);
  }
  for (const [field, declared] of [["logo", ui.logo], ["composerIcon", ui.composerIcon]]) {
    requireCondition(
      errors,
      typeof declared === "string" && declared.startsWith("./"),
      `interface.${field} must be a ./ path.`
    );
    if (typeof declared === "string" && declared.startsWith("./")) {
      validateSvg(errors, path.join(pluginRoot, declared), `interface.${field}`);
    }
  }

  const skillRoot = path.join(pluginRoot, "skills");
  const skills = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  requireCondition(errors, skills.length > 0, "At least one skill is required.");
  for (const skill of skills) {
    const metadataPath = path.join(skillRoot, skill.name, "agents", "openai.yaml");
    requireCondition(errors, fs.existsSync(metadataPath), `${skill.name} is missing agents/openai.yaml.`);
    if (fs.existsSync(metadataPath)) {
      const metadata = YAML.parse(fs.readFileSync(metadataPath, "utf8"));
      requireCondition(
        errors,
        Array.isArray(metadata?.policy?.products)
          && metadata.policy.products.length === 1
          && metadata.policy.products[0] === "CODEX",
        `${skill.name} must be restricted to CODEX.`
      );
    }
  }

  requireCondition(errors, submission.submissionType === "skills-only", "Submission type must be skills-only.");
  requireCondition(
    errors,
    JSON.stringify(submission.supportedProducts) === JSON.stringify(["CODEX"]),
    "Submission products must contain only CODEX."
  );
  requireCondition(
    errors,
    Array.isArray(submission.positiveTests) && submission.positiveTests.length === 5,
    "Submission material must contain exactly five positive tests."
  );
  requireCondition(
    errors,
    Array.isArray(submission.negativeTests) && submission.negativeTests.length === 3,
    "Submission material must contain exactly three negative tests."
  );
  for (const testCase of [...(submission.positiveTests ?? []), ...(submission.negativeTests ?? [])]) {
    for (const field of ["id", "prompt", "setup", "expectedBehavior", "expectedResult"]) {
      requireCondition(
        errors,
        typeof testCase[field] === "string" && testCase[field].trim().length > 0,
        `Test case ${testCase.id ?? "(unknown)"} is missing ${field}.`
      );
    }
  }

  const files = pluginFiles(pluginRoot);
  const relativeFiles = files.map((file) => path.relative(pluginRoot, file).replaceAll("\\", "/"));
  const forbidden = relativeFiles.filter((file) =>
    file === ".mcp.json" || file === ".app.json" || file.startsWith("screenshots/")
  );
  requireCondition(
    errors,
    forbidden.length === 0,
    `Skills-only bundle contains forbidden files: ${forbidden.join(", ")}`
  );
  const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  requireCondition(errors, bytes <= MAX_BUNDLE_BYTES, "Uncompressed plugin content exceeds 100 MiB.");

  if (errors.length > 0) {
    const error = new Error(`Store validation failed:\n- ${errors.join("\n- ")}`);
    error.errors = errors;
    throw error;
  }
  return {
    pluginRoot,
    manifestPath,
    submissionPath,
    files,
    bytes,
    skillCount: skills.length,
    positiveTests: submission.positiveTests.length,
    negativeTests: submission.negativeTests.length
  };
}

function main() {
  try {
    const result = validateStore();
    process.stdout.write(
      `Store validation passed: ${result.skillCount} skills, `
      + `${result.positiveTests} positive tests, ${result.negativeTests} negative tests, `
      + `${result.files.length} files, ${result.bytes} bytes.\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
