import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Sent {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

type Answer = { status: number; body: unknown };

/** A Bot API that records what it gets; answers come from `answers` in order, then 200 ok. */
export class FakeTelegram {
  readonly sent: Sent[] = [];
  readonly answers: Answer[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeTelegram> {
    let fake: FakeTelegram | undefined;
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
        fake!.sent.push({ token: m?.[1] ?? "", method: m?.[2] ?? "", body: JSON.parse(data || "{}") });
        const a = fake!.answers.shift() ?? { status: 200, body: { ok: true, result: {} } };
        res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake = new FakeTelegram(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return fake;
  }

  texts(): string[] {
    return this.sent.map((s) => String(s.body.text));
  }

  /** Resolves once `n` messages came in. */
  async waitFor(n: number, timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.sent.length < n) {
      if (Date.now() > until) throw new Error(`expected ${n} messages, got ${this.sent.length}: ${JSON.stringify(this.texts())}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
