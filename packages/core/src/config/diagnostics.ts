import path from "node:path";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  file?: string;
  /** 1-based */
  line?: number;
  /** 1-based */
  col?: number;
}

/** A path relative to `base` when it lies inside it, otherwise the absolute path. */
export function displayPath(file: string, base?: string): string {
  if (!base) return file;
  const rel = path.relative(base, file);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

/** `file:line:col: error: message`, with the file shown relative to `relativeTo` when it is inside it. */
export function formatDiagnostic(d: Diagnostic, relativeTo?: string): string {
  let where = "";
  if (d.file) {
    const shown = displayPath(d.file, relativeTo);
    where = d.line ? `${shown}:${d.line}:${d.col ?? 1}` : shown;
    where += ": ";
  }
  return `${where}${d.severity}: ${d.message}`;
}
