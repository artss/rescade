import { isMap, isNode, isScalar, type Document, type LineCounter } from "yaml";
import type { Path } from "./issues.js";

/** A parsed YAML file plus what is needed to turn a path into a line and column. */
export interface Source {
  file: string;
  doc: Document;
  lc: LineCounter;
}

export interface Position {
  line: number;
  col: number;
}

/**
 * Finds the line and column of `path` inside a source file. When the path does not exist
 * (a missing required field, say) the nearest existing parent is used instead.
 * With `at: "key"` the position of the last key is returned rather than its value.
 */
export function locate(src: Source, path: Path, at?: "key"): Position {
  if (at === "key" && path.length > 0) {
    const parent = src.doc.getIn(path.slice(0, -1), true);
    const last = path[path.length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
      const range = pair && isNode(pair.key) ? pair.key.range : undefined;
      if (range) return src.lc.linePos(range[0]);
    }
  }

  for (let len = path.length; len >= 0; len--) {
    const node = len === 0 ? src.doc.contents : src.doc.getIn(path.slice(0, len), true);
    if (!isNode(node) || !node.range) continue;

    // The path itself does not exist (a missing field, say): point at the key of the nearest
    // entry that does, so the error lands on "repos: a:" rather than on its first child.
    if (len < path.length && len > 0) {
      const parent = len === 1 ? src.doc.contents : src.doc.getIn(path.slice(0, len - 1), true);
      const key = path[len - 1];
      if (isMap(parent)) {
        const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key);
        const range = pair && isNode(pair.key) ? pair.key.range : undefined;
        if (range) return src.lc.linePos(range[0]);
      }
    }
    return src.lc.linePos(node.range[0]);
  }
  return { line: 1, col: 1 };
}

export function positionAt(src: Source, offset: number): Position {
  return src.lc.linePos(offset);
}
