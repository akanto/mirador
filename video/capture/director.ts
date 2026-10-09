import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { seededRandom } from "./typing.ts";

type Content = string | { type: string; text?: string }[];
type MessagesRequest = {
  model: string;
  stream?: boolean;
  tools?: { name: string }[];
  messages: { role: string; content: Content }[];
};

/** A tool by Claude Code's own name, or one of the canvas's by its action, whatever the canvas server is called. */
export type ToolCall = { tool: "Read" | "Bash" | "Edit" | "Write" | "canvas.show" | "canvas.ask" | "canvas.review"; input: Record<string, unknown> };

/** One reply of the agent: a pause as if thinking, some text, and the tool it calls next, if any. */
export type Step = { thinkMs?: number; say?: string; call?: ToolCall };

/** What the agent does when the user's message contains `prompt`: one step per reply, the next after each tool result. */
export type Script = { prompt: string; steps: Step[] };

const textOf = (content: Content) => (typeof content === "string" ? content : content.map(({ text }) => text ?? "").join(""));
const typedText = (content: Content) => textOf(content).split(/<\/system-reminder>/).at(-1)!.trim();
const isToolResult = (content: Content) => typeof content !== "string" && content.some(({ type }) => type === "tool_result");
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Text streams a few words at a time, the way a model's tokens arrive. */
function chunksOf(text: string) {
  return text.match(/\S+\s*|\s+/g)!.reduce<string[]>((chunks, word, index) => {
    if (index % 3 === 0) chunks.push(word);
    else chunks[chunks.length - 1] += word;
    return chunks;
  }, []);
}

/**
 * Claude's Messages API, played from scripts instead of a model, for the real Claude Code to drive: Claude Code runs
 * the tools a script calls, Mirador shows them, and the trailer films it. A step is found from the conversation
 * itself, by counting the tool results since the user's message, so a retried request gets the same answer.
 */
export class Director {
  /** Every request, so a capture can prove no conversation reached anything but this director. */
  readonly requests: { typed: string; mainLoop: boolean; scripted: boolean }[] = [];
  private server?: Server;
  private readonly random = seededRandom(7);

  constructor(private readonly scripts: Script[]) {}

  async start() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method !== "POST" || !request.url!.startsWith("/v1/messages")) return response.writeHead(200, { "content-type": "application/json" }).end("{}");
        const body = JSON.parse(Buffer.concat(chunks).toString()) as MessagesRequest;
        if (request.url!.startsWith("/v1/messages/count_tokens")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1200 }));
        void this.reply(body, response);
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

  /** Claude Code signs in with a made-up subscription token, never with the person's own account. */
  get environment() {
    return [
      "-u ANTHROPIC_API_KEY",
      "-u ANTHROPIC_AUTH_TOKEN",
      "-u ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "-u ANTHROPIC_DEFAULT_SONNET_MODEL",
      "-u ANTHROPIC_DEFAULT_OPUS_MODEL",
      "-u ANTHROPIC_DEFAULT_FABLE_MODEL",
      `ANTHROPIC_BASE_URL=${this.url}`,
      "CLAUDE_CODE_OAUTH_TOKEN=video-subscription-token",
      "CLAUDE_CODE_MAX_RETRIES=0",
      "DISABLE_TELEMETRY=1",
      "DISABLE_ERROR_REPORTING=1",
    ].join("\n");
  }

  private async reply(body: MessagesRequest, response: ServerResponse) {
    const mainLoop = (body.tools ?? []).length > 0;
    const typedIndex = body.messages.findLastIndex(({ role, content }) => role === "user" && !isToolResult(content) && typedText(content) !== "");
    const typed = typedIndex < 0 ? "" : typedText(body.messages[typedIndex]!.content);
    const script = mainLoop ? this.scripts.find(({ prompt }) => typed.includes(prompt)) : undefined;
    this.requests.push({ typed, mainLoop, scripted: Boolean(script) });
    if (!script) return this.send(body, response, { say: mainLoop ? "Done." : "Mirador demo" }, false);
    const stepIndex = body.messages.slice(typedIndex + 1).filter(({ role, content }) => role === "user" && isToolResult(content)).length;
    const step = script.steps[stepIndex] ?? { say: "" };
    await sleep(step.thinkMs ?? 700);
    await this.send(body, response, step, true);
  }

  private toolName(body: MessagesRequest, call: ToolCall) {
    const names = (body.tools ?? []).map(({ name }) => name);
    if (!call.tool.startsWith("canvas.")) return call.tool;
    const action = call.tool.slice("canvas.".length);
    const name = names.find((each) => each.includes("canvas") && each.endsWith(`__${action}`));
    if (!name) throw new Error(`Claude Code offers no canvas ${action} tool: ${names.join(", ")}`);
    return name;
  }

  private async send(body: MessagesRequest, response: ServerResponse, step: Step, paced: boolean) {
    const id = `msg_video_${this.requests.length}`;
    const usage = { input_tokens: 1200, output_tokens: 80 };
    const call = step.call && { type: "tool_use", id: `toolu_video_${this.requests.length}`, name: this.toolName(body, step.call), input: step.call.input };
    const stopReason = call ? "tool_use" : "end_turn";
    const content = [...(step.say ? [{ type: "text", text: step.say }] : []), ...(call ? [call] : [])];
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return void response.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage }));
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    const event = (data: { type: string } & Record<string, unknown>) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({ type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    let index = 0;
    if (step.say) {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of chunksOf(step.say)) {
        event({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
        if (paced) await sleep(28 + this.random() * 34);
      }
      event({ type: "content_block_stop", index });
      index += 1;
    }
    if (call) {
      event({ type: "content_block_start", index, content_block: { ...call, input: {} } });
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
      event({ type: "content_block_stop", index });
    }
    event({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 80 } });
    event({ type: "message_stop" });
    response.end();
  }
}
