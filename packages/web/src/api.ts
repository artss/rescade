import { clearToken, getToken } from "./token.js";

/** An error answer of the daemon, or no answer at all (`status` 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The API is served next to the page, under `/api`. */
export async function request<T>(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<T> {
  const res = await send(method, path, signal);
  return (await res.json()) as T;
}

/** Sends a request with the token and turns an error answer into ApiError; a 401 drops the token. */
export async function send(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<Response> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, `cannot reach the daemon (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.ok) return res;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // not JSON: keep the status line
  }
  // a late answer to a request sent with a token replaced since must not drop the new one
  if (res.status === 401 && getToken() === token) clearToken(true);
  throw new ApiError(res.status, message);
}
