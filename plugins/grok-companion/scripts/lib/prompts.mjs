import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? "") : "";
  });
}

export function escapeUntrustedPromptData(value, containerName) {
  const text = String(value ?? "");
  const escapedName = String(containerName ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedName) {
    return text;
  }
  const delimiter = new RegExp(`<\\/?${escapedName}\\s*>`, "gi");
  return text.replace(delimiter, (match) => match.replace("<", "&lt;").replace(">", "&gt;"));
}
