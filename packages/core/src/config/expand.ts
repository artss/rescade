export interface ExpandResult {
  value: string;
  /** Names of every variable referenced, in order of appearance. */
  referenced: string[];
  /** Referenced variables that are unset and have no default. */
  missing: string[];
  /** Malformed references. */
  errors: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Expands `${VAR}` and `${VAR:-default}` in a string. `$$` is a literal `$`.
 * The default applies when the variable is unset or empty, as in a POSIX shell.
 * Values taken from the environment are inserted as-is and never re-expanded.
 */
export function expandString(
  input: string,
  env: Record<string, string | undefined>,
  /** What a missing variable expands to. Defaults to the empty string. */
  placeholder: (name: string) => string = () => "",
): ExpandResult {
  const referenced: string[] = [];
  const missing: string[] = [];
  const errors: string[] = [];
  let out = "";
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next !== "{") {
      out += ch;
      i++;
      continue;
    }
    const end = input.indexOf("}", i + 2);
    if (end === -1) {
      errors.push('unterminated "${" reference');
      out += input.slice(i);
      break;
    }
    const inner = input.slice(i + 2, end);
    const sep = inner.indexOf(":-");
    const name = sep === -1 ? inner : inner.slice(0, sep);
    const fallback = sep === -1 ? undefined : inner.slice(sep + 2);
    if (!NAME_RE.test(name)) {
      errors.push("invalid variable reference \"${" + inner + "}\"");
      out += input.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    referenced.push(name);
    const value = env[name];
    if (value === undefined || (value === "" && fallback !== undefined)) {
      if (fallback !== undefined) out += fallback;
      else {
        missing.push(name);
        out += placeholder(name);
      }
    } else {
      out += value;
    }
    i = end + 1;
  }

  return { value: out, referenced, missing, errors };
}
