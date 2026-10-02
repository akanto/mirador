import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type MessagesRequest = {
  model: string;
  stream?: boolean;
  system?: string | { text: string }[];
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
};

const systemTextOf = ({ system }: MessagesRequest) => (typeof system === "string" ? system : (system ?? []).map(({ text }) => text).join("\n"));

const textOf = (content: MessagesRequest["messages"][number]["content"]) =>
  typeof content === "string" ? content : content.map(({ text }) => text ?? "").join("");

/** What a reply quotes: the newest text the user typed, after Claude Code's system reminders. */
const lastTypedText = ({ messages }: MessagesRequest) =>
  textOf(messages.findLast(({ role }) => role === "user")?.content ?? "")
    .split(/<\/system-reminder>/)
    .at(-1)!
    .trim();

/**
 * Claude's Messages API for a subscription that Claude Code believes it signs in to (CLAUDE_CODE_OAUTH_TOKEN): while
 * `limited`, every request is refused the way the API refuses once a usage limit is reached; otherwise each reply
 * quotes the user's newest message.
 */
export class FakeClaudeApi {
  limited = true;
  /** When the limit resets, in epoch seconds; Claude Code shows it as "resets 6:20pm (Europe/Budapest)". */
  resetsAt = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
  readonly answered: string[] = [];
  /** The system prompt each request carried, by the text the user typed last. */
  readonly systemPrompts = new Map<string, string>();
  readonly refused: string[] = [];
  private server?: Server;

  async start() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method !== "POST" || !request.url!.startsWith("/v1/messages")) return response.writeHead(200).end("{}");
        this.reply(JSON.parse(Buffer.concat(chunks).toString()) as MessagesRequest, response);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  get url() {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  stop() {
    this.server?.close();
  }

  private reply(body: MessagesRequest, response: ServerResponse) {
    const typed = lastTypedText(body);
    this.systemPrompts.set(typed, systemTextOf(body));
    if (this.limited) {
      this.refused.push(typed);
      response.writeHead(429, { "content-type": "application/json", ...this.limitHeaders() });
      return response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }));
    }
    this.answered.push(typed);
    const text = `Answered: ${typed}`;
    const usage = { input_tokens: 10, output_tokens: 5 };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: { type: string } & Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    send({ type: "message_stop" });
    response.end();
  }

  private limitHeaders() {
    const reset = String(this.resetsAt);
    return {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": reset,
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": reset,
    };
  }
}

/** Claude Code signs in with a made-up subscription token and gives up at the first refusal instead of retrying. */
export const subscriptionEnvironment = (api: FakeClaudeApi) =>
  ["-u ANTHROPIC_API_KEY", "-u ANTHROPIC_AUTH_TOKEN", `ANTHROPIC_BASE_URL=${api.url}`, "CLAUDE_CODE_OAUTH_TOKEN=e2e-subscription-token", "CLAUDE_CODE_MAX_RETRIES=0"].join("\n");
