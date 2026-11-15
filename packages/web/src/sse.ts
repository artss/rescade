import { send } from "./api.js";
import type { ServerEvent } from "./types.js";

/** Splits a server-sent event stream into the `data:` of its events; comments are skipped. */
export async function* parseEvents(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data !== "") yield data;
    }
  }
}

// ReadableStream is not async iterable in every browser
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export interface EventHandlers {
  onEvent(event: ServerEvent): void;
  /** On every (re)connect: whatever happened while the stream was down has to be asked for again. */
  onOpen(): void;
  onDown(error: unknown): void;
}

/**
 * Follows `/api/events` until `signal` aborts, reconnecting after `retryMs`.
 * `EventSource` cannot send the token header, so the stream is read with fetch.
 */
export async function followEvents(handlers: EventHandlers, signal: AbortSignal, retryMs = 2000): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await send("GET", "/events", signal);
      handlers.onOpen();
      for await (const data of parseEvents(chunks(res.body!))) handlers.onEvent(JSON.parse(data) as ServerEvent);
      if (!signal.aborted) handlers.onDown(new Error("the daemon closed the event stream"));
    } catch (e) {
      if (signal.aborted) return;
      handlers.onDown(e);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, retryMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
