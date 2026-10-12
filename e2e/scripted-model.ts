import { existsSync } from "node:fs";
import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

type ChatMessage = { role: string; content?: string | { type: string; text?: string }[] | null };
type ChatRequest = { messages: ChatMessage[]; tools?: { function: { name: string; description?: string } }[] };
type ToolCall = { name: string; arguments: Record<string, unknown> };

const textOf = (message: ChatMessage | undefined) =>
  typeof message?.content === "string" ? message.content : (message?.content ?? []).map(({ text }) => text ?? "").join("");

/** opencode 2 hands the model a failed tool's result as JSON with the error in it, opencode 1 as the bare message. */
const toolResultOf = (message: ChatMessage) => {
  const text = textOf(message);
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
  } catch {
    return text;
  }
};

const chunk = (delta: object, finishReason: string | null = null) => ({
  id: "scripted",
  object: "chat.completion.chunk",
  created: 0,
  model: "scripted",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/** Every reply reports the same token usage, so opencode's context report has a known value. */
export const SCRIPTED_PROMPT_TOKENS = 42_000;
const finish = (finishReason: string) => ({
  ...chunk({}, finishReason),
  usage: { prompt_tokens: SCRIPTED_PROMPT_TOKENS, completion_tokens: 500, total_tokens: SCRIPTED_PROMPT_TOKENS + 500 },
});

/**
 * An OpenAI-compatible model for opencode that follows a script instead of thinking: the last
 * user message decides the reply. `RUN <command>` calls the shell tool, `SHOW <title>` and `ASK <question>`
 * call the canvas tools, `CALL <tool> <JSON arguments>` any of them, `DELEGATE <prompt>` starts an opencode 2
 * subagent whose own script is the prompt, a tool result is echoed back, anything else is echoed as text.
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

  /** The user's messages in the latest request for a reply, not a title: what the agent's context holds of the conversation. */
  userMessagesInContext() {
    const latestReply = this.requests.findLast(({ tools }) => (tools ?? []).length > 0);
    return (latestReply?.messages ?? []).filter(({ role }) => role === "user").map(textOf);
  }

  private reply(request: ChatRequest, response: ServerResponse) {
    const tools = (request.tools ?? []).map(({ function: { name } }) => name);
    const last = request.messages.at(-1);
    if (tools.length === 0) return this.stream(response, [chunk({ role: "assistant", content: "Scripted title" }), finish("stop")]);
    if (last?.role === "tool") return this.say(response, `Tool result: ${toolResultOf(last)}`);
    const text = textOf(last).trim();
    const canvasTool = (action: string) => tools.find((name) => name.includes("canvas") && name.endsWith(action))!;
    const shellTool = tools.includes("shell") ? "shell" : "bash";
    const script = text.split("\n").at(-1)!.trim(); // opencode 2 puts its own lines before a subagent's prompt
    const [directive, ...rest] = script.split(" ");
    const argument = rest.join(" ");
    if (directive === "RUN") return this.call(response, { name: shellTool, arguments: { command: argument, description: "Run the scripted command" } });
    if (directive === "DELEGATE") return this.call(response, { name: "subagent", arguments: { agent: "general", description: "Scripted subagent", prompt: argument } });
    if (directive === "CALL") {
      const [tool, ...json] = rest;
      return this.call(response, { name: canvasTool(tool!), arguments: JSON.parse(json.join(" ")) });
    }
    if (directive === "SHOW") {
      return this.call(response, { name: canvasTool("show"), arguments: { title: argument, html: `<h1>${argument}</h1>` } });
    }
    if (directive === "ASK") {
      const context = `<h2>Why this matters</h2><div style="height:600px">Taller than the frame's starting height</div>`;
      const options = [{ label: "Red", html: `<div style="height:100px">Red swatch</div>` }, { label: "Blue" }];
      return this.call(response, { name: canvasTool("ask"), arguments: { question: argument, html: context, options } });
    }
    return this.say(response, `Echo: ${text}`);
  }

  private say(response: ServerResponse, text: string) {
    this.stream(response, [chunk({ role: "assistant", content: text }), finish("stop")]);
  }

  private call(response: ServerResponse, { name, arguments: args }: ToolCall) {
    const toolCall = { index: 0, id: `call_${this.requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
    this.stream(response, [chunk({ role: "assistant", tool_calls: [toolCall] }), finish("tool_calls")]);
  }

  private stream(response: ServerResponse, chunks: object[]) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`);
  }
}

/** Enough models that the app offers its searchable model picker, as it does for a real opencode with many providers. */
export const SPARE_MODELS = 24;

/**
 * A profile environment that points opencode at the scripted model and keeps it away from the
 * user's own opencode setup: config, plugins, agents and session database all live under `root`.
 */
export function scriptedOpencodeEnvironment(model: ScriptedModel, root: string) {
  const scriptedModel = (name: string) => ({
    name,
    modalities: { input: ["text", "image"], output: ["text"] },
    supportsToolCalls: true,
    attachment: true,
    limit: { context: 100_000, output: 4_096 },
  });
  const spareModels = Object.fromEntries(Array.from({ length: SPARE_MODELS }, (_, index) => [`spare-${index + 1}`, scriptedModel(`Spare model ${index + 1}`)]));
  const config = {
    model: "e2e/scripted",
    enabled_providers: ["e2e", "spare"],
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E",
        options: { baseURL: model.url, apiKey: "unused" },
        models: { scripted: scriptedModel("Scripted") },
      },
      spare: {
        npm: "@ai-sdk/openai-compatible",
        name: "Spare",
        options: { baseURL: model.url, apiKey: "unused" },
        models: spareModels,
      },
    },
    permission: { bash: "ask", shell: "ask" },
  };
  return [
    `XDG_CONFIG_HOME=${root}/opencode-config`,
    `XDG_DATA_HOME=${root}/opencode-data`,
    `XDG_STATE_HOME=${root}/opencode-state`,
    `OPENCODE_CONFIG_CONTENT='${JSON.stringify(config)}'`,
  ].join("\n");
}

/** opencode as the host finds it: on PATH, else where its installer puts it. */
export function opencodeProgram() {
  const installDirectory = join(homedir(), ".opencode", "bin");
  const searchedDirectories = [...(process.env.PATH ?? "").split(delimiter), installDirectory];
  const found = searchedDirectories.map((directory) => join(directory, "opencode")).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`opencode is neither on PATH nor in ${installDirectory}`);
  return found;
}
