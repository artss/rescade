import { readFileSync } from "node:fs";

/** The version of rescade; the same path from src (tests) and dist. */
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;
