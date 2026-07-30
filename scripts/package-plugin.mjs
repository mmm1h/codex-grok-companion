import { createWriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";

import { validateStore } from "./store-validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".svg", ".yaml", ".yml"]);

function normalizedRelative(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

export function archiveContent(file) {
  const content = fs.readFileSync(file);
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return content;
  }
  return Buffer.from(content.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function verifyPluginZip(zipPath, expectedNames, expectedRoot) {
  const expected = [...expectedNames].sort();
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }
      const names = [];
      let uncompressedBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          zipFile.close();
          reject(error);
        }
      };
      zipFile.on("error", fail);
      zipFile.on("entry", (entry) => {
        const name = entry.fileName;
        if (
          name.endsWith("/")
          || name.includes("\\")
          || name.startsWith("/")
          || name.split("/").includes("..")
          || !name.startsWith(`${expectedRoot}/`)
        ) {
          fail(new Error(`Unsafe or unexpected ZIP entry: ${name}`));
          return;
        }
        names.push(name);
        uncompressedBytes += entry.uncompressedSize;
        if (names.length > expected.length || uncompressedBytes > 100 * 1024 * 1024) {
          fail(new Error("ZIP exceeds the validated entry or size budget."));
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          stream.on("error", fail);
          stream.on("data", () => {});
          stream.on("end", () => zipFile.readEntry());
        });
      });
      zipFile.on("end", () => {
        if (settled) {
          return;
        }
        const actual = names.sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          fail(new Error("ZIP entries do not exactly match the validated plugin files."));
          return;
        }
        settled = true;
        resolve({ fileCount: actual.length, uncompressedBytes });
      });
      zipFile.readEntry();
    });
  });
}

export async function packagePlugin(options = {}) {
  const buildRoot = options.root ?? ROOT;
  const validation = validateStore(buildRoot);
  const manifest = JSON.parse(fs.readFileSync(validation.manifestPath, "utf8"));
  const outPath = path.resolve(
    options.outPath ?? path.join(buildRoot, "dist", `${manifest.name}-${manifest.version}.zip`)
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const output = createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const complete = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
  });
  archive.pipe(output);
  for (const file of validation.files) {
    archive.append(archiveContent(file), {
      name: `${manifest.name}/${normalizedRelative(validation.pluginRoot, file)}`,
      date: FIXED_DATE,
      mode: 0o100644
    });
  }
  await archive.finalize();
  await complete;
  const expectedNames = validation.files.map(
    (file) => `${manifest.name}/${normalizedRelative(validation.pluginRoot, file)}`
  );
  const verified = await verifyPluginZip(outPath, expectedNames, manifest.name);

  return {
    outPath,
    bytes: fs.statSync(outPath).size,
    fileCount: validation.files.length,
    root: manifest.name,
    verified
  };
}

async function main() {
  try {
    const outIndex = process.argv.indexOf("--out");
    const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
    if (outIndex >= 0 && !outPath) {
      throw new Error("--out requires a path.");
    }
    const result = await packagePlugin({ outPath });
    process.stdout.write(
      `Created ${result.outPath} (${result.bytes} bytes, ${result.fileCount} files, root ${result.root}/).\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
