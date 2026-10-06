import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * An agent that takes every prompt and never finishes it, ignoring `session/cancel`, the way a model request against a
 * llama.cpp still loading its model leaves a turn: the agent is wedged, so only killing its process ends the turn.
 * Prompts are appended to the file in `FAKE_ACP_PROMPTS`, so a test can see a turn was sent again after the kill.
 */
const promptsFile = process.env.FAKE_ACP_PROMPTS;
const wedging = (prompt: acp.ContentBlock[]) => prompt.every((block) => block.type === "text" && block.text.startsWith("WEDGE"));

let nextSession = 0;

acp
  .agent()
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `fake-session-${++nextSession}` }))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => {
    const text = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    appendFileSync(promptsFile!, `${text}\n`);
    return wedging(ctx.params.prompt) ? new Promise(() => {}) : { stopReason: "end_turn" as const };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
