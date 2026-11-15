import os from "node:os";
import path from "node:path";
import { readTokenFile } from "@rescade/core";

export const DEFAULT_URL = "http://127.0.0.1:8765";

export interface Connection {
  url: string;
  token: string;
}

/** An error to show the user as it is, without a stack. */
export class ClientError extends Error {}

/**
 * Where the daemon is and the token for it. The token comes from --token-file, RESCADE_TOKEN,
 * RESCADE_TOKEN_FILE or ~/.config/rescade/token, in that order.
 */
export async function resolveConnection(
  flags: { url?: string; tokenFile?: string },
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): Promise<Connection> {
  const url = (flags.url ?? (env.RESCADE_URL || DEFAULT_URL)).replace(/\/+$/, "");
  if (flags.tokenFile === undefined && env.RESCADE_TOKEN) return { url, token: env.RESCADE_TOKEN };
  const file = flags.tokenFile ?? (env.RESCADE_TOKEN_FILE || path.join(os.homedir(), ".config", "rescade", "token"));
  try {
    const { token, warning } = await readTokenFile(file);
    if (warning !== undefined) warn(warning);
    return { url, token };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new ClientError(`no API token: ${why}\nput the daemon's token there, or set RESCADE_TOKEN or RESCADE_TOKEN_FILE`);
  }
}

export interface ServerEvent {
  kind: string;
  [key: string]: unknown;
}

export class ApiClient {
  constructor(private readonly conn: Connection) {}

  get<T>(pathAndQuery: string): Promise<T> {
    return this.request<T>("GET", pathAndQuery);
  }

  post<T>(pathAndQuery: string): Promise<T> {
    return this.request<T>("POST", pathAndQuery);
  }

  /** Opens the event stream; resolves once the daemon has accepted it, so no later event is missed. */
  async events(query: string, signal: AbortSignal): Promise<AsyncGenerator<ServerEvent>> {
    const res = await this.fetch("GET", `/events${query}`, signal);
    await this.check(res);
    return parseEvents(res.body!, signal);
  }

  private async request<T>(method: string, pathAndQuery: string): Promise<T> {
    const res = await this.fetch(method, pathAndQuery);
    await this.check(res);
    return (await res.json()) as T;
  }

  private async fetch(method: string, pathAndQuery: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.conn.url}/api${pathAndQuery}`, {
        method,
        headers: { authorization: `Bearer ${this.conn.token}` },
        signal,
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
      throw new ClientError(`cannot reach the daemon at ${this.conn.url} (${why})`);
    }
  }

  private async check(res: Response): Promise<void> {
    if (res.ok) return;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON: keep the status line
    }
    if (res.status === 401) message = `the daemon rejected the API token (${message})`;
    throw new ClientError(message);
  }
}

/** Parses `event:` / `data:` blocks of a server-sent event stream; comments are skipped. */
async function* parseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data !== "") yield JSON.parse(data) as ServerEvent;
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    throw new ClientError(`lost the connection to the daemon (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    reader.releaseLock();
  }
}
