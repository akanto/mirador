import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * An agent that takes every prompt and never finishes it, ignoring `session/cancel`, the way a model request against a
 * llama.cpp still loading its model leaves a turn: the agent is wedged, so only killing its process ends the turn.
 * A prompt starting with CRASH makes the process die in the middle of the turn instead. One of `EDIT ` and a JSON
 * array of edits asks permission for each edit at once, and ends the turn with what the user answered to each; `TOOLS `
 * and a JSON array of `{"kind": toolKind, "title": text}` does the same for tools of any kind.
 * `WRITE ` and a JSON array of steps changes files as it goes: `{"edit": path, "content": text}` writes the file with
 * an edit tool call and its diff, `{"shell": path, "content": text}` writes it from a shell command, and
 * `{"waitFor": path}` holds the turn until that file exists.
 * Prompts are appended to the file in `FAKE_ACP_PROMPTS`, so a test can see a turn was sent again after the kill.
 *
 * Its profile can give it more: `FAKE_ACP_MODES=1` offers Mode and Effort options and lets sessions be closed, and
 * `FAKE_ACP_ANSWERS_AFTER_MS` answers option changes and closes that late, as Claude Code does while its first
 * request waits for a model server to load the model. Starts, changes and closes go to the file in `FAKE_ACP_LOG`,
 * each with the name in `FAKE_ACP_NAME`. FAKE_ACP_IGNORES_SIGTERM=1 makes it survive SIGTERM, and FAKE_ACP_PID_FILE
 * names a file it writes its pid to.
 */
const promptsFile = process.env.FAKE_ACP_PROMPTS;
const offersModes = process.env.FAKE_ACP_MODES === "1";
const answersAfterMs = Number(process.env.FAKE_ACP_ANSWERS_AFTER_MS ?? 0);
const ignoresSigterm = process.env.FAKE_ACP_IGNORES_SIGTERM === "1";
const startsWith = (prompt: acp.ContentBlock[], word: string) => prompt.every((block) => block.type === "text" && block.text.startsWith(word));

const log = (entry: string) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, `${process.env.FAKE_ACP_NAME ?? "agent"} ${entry}\n`);
const answerLate = async <T>(answer: () => T) => {
  await Bun.sleep(answersAfterMs);
  return answer();
};

const chosen = new Map<string, Record<string, string>>();
const choice = (sessionId: string, configId: string, otherwise: string) => chosen.get(sessionId)?.[configId] ?? otherwise;
const configOptions = (sessionId: string): acp.SessionConfigOption[] => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: choice(sessionId, "mode", "default"),
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: choice(sessionId, "effort", "low"),
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

let nextSession = 0;

interface ProposedEdit {
  title: string;
  path: string;
  oldText: string | null;
  newText: string;
}

const permissionOptions: acp.PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/** Asks permission for every tool call at once, and ends the turn with what the user answered to each. */
async function askPermissions(client: acp.AgentContext, sessionId: string, toolCalls: (acp.ToolCallUpdate & { title: string })[]) {
  const answers = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const response = await client.request(acp.methods.client.session.requestPermission, { sessionId, toolCall, options: permissionOptions });
      return `${toolCall.title}: ${response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled"}`;
    }),
  );
  await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answers.join("; ") } } });
  return { stopReason: "end_turn" as const };
}

const askToEdit = (client: acp.AgentContext, sessionId: string, edits: ProposedEdit[]) =>
  askPermissions(
    client,
    sessionId,
    edits.map(({ title, path, oldText, newText }, index) => ({ toolCallId: `edit-${index}`, title, kind: "edit", status: "pending", locations: [{ path }], content: [{ type: "diff", path, oldText, newText }] })),
  );

/** Tools of any other kind, named by their title alone, as Claude Code asks to read a file or fetch a page. */
const askToUseTools = (client: acp.AgentContext, sessionId: string, tools: { kind: acp.ToolKind; title: string }[]) =>
  askPermissions(client, sessionId, tools.map(({ kind, title }, index) => ({ toolCallId: `tool-${index}`, title, kind, status: "pending" })));

type WriteStep = { edit: string; content: string } | { shell: string; content: string } | { waitFor: string };

let nextToolCall = 0;

async function writeFiles(client: acp.AgentContext, sessionId: string, steps: WriteStep[]) {
  const update = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId, update });
  for (const step of steps) {
    if ("waitFor" in step) {
      while (!existsSync(step.waitFor)) await Bun.sleep(50);
      continue;
    }
    const toolCallId = `write-${++nextToolCall}`;
    const path = "edit" in step ? step.edit : step.shell;
    await update({ sessionUpdate: "tool_call", toolCallId, title: "edit" in step ? `Write ${path}` : `echo > ${path}`, kind: "edit" in step ? "edit" : "execute", status: "pending" });
    const oldText = existsSync(path) ? readFileSync(path, "utf8") : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, step.content);
    if ("edit" in step) await update({ sessionUpdate: "tool_call_update", toolCallId, locations: [{ path }], content: [{ type: "diff", path, oldText, newText: step.content }] });
    await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  }
  return { stopReason: "end_turn" as const };
}

/** The agent's own plan, as Claude Code sends its to-do list: each entry "done" or not, the first one not done in progress. */
async function makePlan(client: acp.AgentContext, sessionId: string, steps: { content: string; done: boolean }[]) {
  const firstOpen = steps.findIndex(({ done }) => !done);
  const entries = steps.map(({ content, done }, index): acp.PlanEntry => ({
    content,
    priority: "medium",
    status: done ? "completed" : index === firstOpen ? "in_progress" : "pending",
  }));
  await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "plan", entries } });
  return { stopReason: "end_turn" as const };
}

if (ignoresSigterm) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}
if (process.env.FAKE_ACP_PID_FILE) writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));

log("started");
acp
  .agent()
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: offersModes ? { sessionCapabilities: { close: {} } } : {},
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `fake-session-${process.pid}-${++nextSession}`;
    return offersModes ? { sessionId, configOptions: configOptions(sessionId) } : { sessionId };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) =>
    answerLate(() => {
      chosen.set(ctx.params.sessionId, { ...chosen.get(ctx.params.sessionId), [ctx.params.configId]: String(ctx.params.value) });
      log(`set ${ctx.params.configId} to ${ctx.params.value}`);
      return { configOptions: configOptions(ctx.params.sessionId) };
    }),
  )
  .onRequest(acp.methods.agent.session.close, (ctx) =>
    answerLate(() => {
      log(`closed ${ctx.params.sessionId}`);
      return {};
    }),
  )
  .onRequest(acp.methods.agent.session.prompt, (ctx) => {
    const text = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    appendFileSync(promptsFile!, `${text}\n`);
    if (startsWith(ctx.params.prompt, "EDIT ")) return askToEdit(ctx.client, ctx.params.sessionId, JSON.parse(text.slice("EDIT ".length)));
    if (startsWith(ctx.params.prompt, "TOOLS ")) return askToUseTools(ctx.client, ctx.params.sessionId, JSON.parse(text.slice("TOOLS ".length)));
    if (startsWith(ctx.params.prompt, "WRITE ")) return writeFiles(ctx.client, ctx.params.sessionId, JSON.parse(text.slice("WRITE ".length)));
    if (startsWith(ctx.params.prompt, "PLAN ")) return makePlan(ctx.client, ctx.params.sessionId, JSON.parse(text.slice("PLAN ".length)));
    if (startsWith(ctx.params.prompt, "CRASH")) setTimeout(() => process.exit(1), 100);
    return startsWith(ctx.params.prompt, "WEDGE") || startsWith(ctx.params.prompt, "CRASH") ? new Promise(() => {}) : { stopReason: "end_turn" as const };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
