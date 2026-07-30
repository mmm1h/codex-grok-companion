export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const rawKey = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      const key = aliasMap[rawKey] ?? rawKey;
      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }
      if (valueOptions.has(key)) {
        const value = inlineValue ?? argv[index + 1];
        if (value === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = value;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }
      positionals.push(token);
      continue;
    }

    const rawKey = token.slice(1);
    const key = aliasMap[rawKey] ?? rawKey;
    if (booleanOptions.has(key)) {
      options[key] = true;
    } else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for -${rawKey}`);
      }
      options[key] = value;
      index += 1;
    } else {
      positionals.push(token);
    }
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  const source = String(raw ?? "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      const escapesNext = next !== undefined && (
        next === "\\" ||
        next === quote ||
        (!quote && (next === "'" || next === "\"" || /\s/.test(next)))
      );
      if (escapesNext) {
        current += next;
        index += 1;
      } else {
        current += "\\";
      }
    } else if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }

  if (quote) {
    throw new Error("Unterminated quote in arguments.");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  const raw = String(argv[0] ?? "");
  // A single positional is already an argv token. Only split the legacy
  // slash-command form that packs option text into one string.
  if (!raw.trimStart().startsWith("-") || !/\s/.test(raw)) {
    return argv;
  }
  return splitRawArgumentString(raw);
}
