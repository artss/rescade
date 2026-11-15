import { readFile, stat } from "node:fs/promises";

export interface TokenFile {
  token: string;
  /** Set when the file can be read by others than its owner. */
  warning?: string;
}

/** Reads an API token from a file: the first line, trimmed. Throws if the file is missing or empty. */
export async function readTokenFile(file: string): Promise<TokenFile> {
  const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  const token = text.split("\n")[0]!.trim();
  if (token === "") throw new Error(`${file}: the token file is empty`);
  if ((info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8);
    return { token, warning: `${file}: the token file has mode ${mode}, others can read it (chmod 600 ${file})` };
  }
  return { token };
}
