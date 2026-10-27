// A fake Resend for the vitest suites and the image smoke: takes sends (with
// Idempotency-Key handling like the real one) and serves the Receiving API.
// Plain node: imports only, so Node's type stripping and vitest both load it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSend {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: { filename: string; path: string; content_type?: string; content_id?: string }[];
  tags?: { name: string; value: string }[];
  auth: string | undefined;
  key: string | undefined;
}

/** A planned failure for the next send: an HTTP status, or "lose" (accept the
 *  email, then answer 500, as if the answer got lost). */
export type SendFault = number | "lose";

export class FakeResend {
  readonly sent: FakeSend[] = [];
  /** Every Receiving API path asked for. */
  readonly fetched: string[] = [];
  /** Received emails the Receiving API serves, by ID. */
  readonly inbound = new Map<string, Record<string, unknown>>();
  /** Answers for the next sends, in order. */
  sendFaults: SendFault[] = [];
  /** Statuses for the next Receiving API calls, in order. */
  getFaults: number[] = [];
  /** Answer 422 to any send with attachments. */
  refuseAttachments = false;
  /** Sign attachment links freshly on each fetch, like the real CDN. */
  rotateLinks = false;
  /** Answer sends slowly, like a real mail API. */
  delayMs = 0;
  private readonly keys = new Map<string, string>();
  private links = 0;
  private server: Server | null = null;

  reset(): void {
    this.sent.length = 0;
    this.fetched.length = 0;
    this.inbound.clear();
    this.keys.clear();
    this.sendFaults = [];
    this.getFaults = [];
    this.refuseAttachments = false;
    this.rotateLinks = false;
  }

  async listen(host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, host, () => r()));
    const port = (this.server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, port };
  }

  close(): void {
    this.server?.close();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const json = (status: number, body: unknown): void =>
        void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = req.url ?? "";
      const receiving = /^\/emails\/receiving\/([\w-]+)(\/attachments)?(\?.*)?$/.exec(url);
      if (req.method === "GET" && receiving) {
        this.fetched.push(url);
        const fault = this.getFaults.shift();
        if (fault) return json(fault, { name: "application_error" });
        const e = this.inbound.get(receiving[1]!);
        if (!e) return json(404, { name: "not_found" });
        if (!receiving[2]) return json(200, e);
        const sig = this.rotateLinks ? `?sig=${(this.links += 1)}` : "";
        const files = (e["attachments"] ?? []) as { id: string }[];
        return json(200, { object: "list", has_more: false, data: files.map((a) => ({ ...a, download_url: `https://inbound-cdn.test/${a.id}${sig}` })) });
      }
      if (req.method !== "POST" || url !== "/emails") return void res.writeHead(404).end();
      const key = req.headers["idempotency-key"] as string | undefined;
      const answer = (): void => {
        if (key && this.keys.has(key)) {
          if (this.keys.get(key) === raw) return json(200, { id: `fake-${key}` });
          return json(409, { name: "invalid_idempotent_request", message: "body changed" });
        }
        const mail = JSON.parse(raw) as Omit<FakeSend, "auth" | "key">;
        const fault = this.sendFaults.shift();
        if (typeof fault === "number") return json(fault, { name: "fault" });
        if (this.refuseAttachments && mail.attachments) return json(422, { name: "invalid_attachment" });
        const id = `fake-${this.sent.length + 1}`;
        this.sent.push({ ...mail, auth: req.headers.authorization, key });
        if (key) this.keys.set(key, raw);
        if (fault === "lose") return json(500, { name: "internal_server_error" });
        json(200, { id });
      };
      if (this.delayMs) setTimeout(answer, this.delayMs);
      else answer();
    });
  }
}
