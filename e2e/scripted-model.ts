import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type ChatMessage = { role: string; content?: string | { type: string; text?: string }[] | null };
type ChatRequest = { messages: ChatMessage[]; tools?: { function: { name: string } }[] };
type ToolCall = { name: string; arguments: Record<string, unknown> };

const textOf = (message: ChatMessage | undefined) =>
  typeof message?.content === "string" ? message.content : (message?.content ?? []).map(({ text }) => text ?? "").join("");

const chunk = (delta: object, finishReason: string | null = null) => ({
  id: "scripted",
  object: "chat.completion.chunk",
  created: 0,
  model: "scripted",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/**
 * An OpenAI-compatible model for opencode that follows a script instead of thinking: the last
 * user message decides the reply. `RUN <command>` calls bash, `SHOW <title>` and `ASK <question>`
 * call the canvas tools, a tool result is echoed back, anything else is echoed as text.
 */
export class ScriptedModel {
  readonly requests: ChatRequest[] = [];
  private server?: Server;

  async start() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as ChatRequest;
        this.requests.push(body);
        this.reply(body, response);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  get url() {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
  }

  stop() {
    this.server?.close();
  }

  /** Every text the agent sent the model, to check what context a conversation carries. */
  textsSent() {
    return this.requests.flatMap(({ messages }) => messages.map(textOf));
  }

  private reply(request: ChatRequest, response: ServerResponse) {
    const tools = (request.tools ?? []).map(({ function: { name } }) => name);
    const last = request.messages.at(-1);
    if (tools.length === 0) return this.stream(response, [chunk({ role: "assistant", content: "Scripted title" }), chunk({}, "stop")]);
    if (last?.role === "tool") return this.say(response, `Tool result: ${textOf(last)}`);
    const text = textOf(last).trim();
    const canvasTool = (action: string) => tools.find((name) => name.includes("canvas") && name.endsWith(action))!;
    const [directive, ...rest] = text.split(" ");
    const argument = rest.join(" ");
    if (directive === "RUN") return this.call(response, { name: "bash", arguments: { command: argument, description: "Run the scripted command" } });
    if (directive === "SHOW") {
      return this.call(response, { name: canvasTool("show"), arguments: { title: argument, html: `<h1>${argument}</h1>` } });
    }
    if (directive === "ASK") {
      return this.call(response, { name: canvasTool("ask"), arguments: { question: argument, options: [{ label: "Red" }, { label: "Blue" }] } });
    }
    return this.say(response, `Echo: ${text}`);
  }

  private say(response: ServerResponse, text: string) {
    this.stream(response, [chunk({ role: "assistant", content: text }), chunk({}, "stop")]);
  }

  private call(response: ServerResponse, { name, arguments: args }: ToolCall) {
    const toolCall = { index: 0, id: `call_${this.requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
    this.stream(response, [chunk({ role: "assistant", tool_calls: [toolCall] }), chunk({}, "tool_calls")]);
  }

  private stream(response: ServerResponse, chunks: object[]) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`);
  }
}

/**
 * A profile environment that points opencode at the scripted model and keeps it away from the
 * user's own opencode setup: config, plugins, agents and session database all live under `root`.
 */
export function scriptedOpencodeEnvironment(model: ScriptedModel, root: string) {
  const config = {
    model: "e2e/scripted",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E",
        options: { baseURL: model.url, apiKey: "unused" },
        models: {
          scripted: {
            name: "Scripted",
            modalities: { input: ["text"], output: ["text"] },
            supportsToolCalls: true,
            attachment: false,
            limit: { context: 100_000, output: 4_096 },
          },
        },
      },
    },
    permission: { bash: "ask" },
  };
  return [
    `XDG_CONFIG_HOME=${root}/opencode-config`,
    `XDG_DATA_HOME=${root}/opencode-data`,
    `XDG_STATE_HOME=${root}/opencode-state`,
    `OPENCODE_CONFIG_CONTENT='${JSON.stringify(config)}'`,
  ].join("\n");
}
