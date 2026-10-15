import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessProcess } from "../host/acp/harness.ts";

/** Answers initialize and session/new, then dies with exit code 3 in the middle of the first prompt. */
const crashingAgent = `
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\\n")) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "session/prompt") setTimeout(() => process.exit(3), 50);
    else if (request.id !== undefined) {
      const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion, agentCapabilities: {} } : { sessionId: "crashing" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    }
  }
});
process.stdin.resume();
`;

/** Bun on Windows sometimes never reports the end of an exited agent's stdout; a child holding it open does the same anywhere. */
const crashingAgentWhoseChildHoldsItsOutput = `
require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: ["ignore", "inherit", "ignore"] });
${crashingAgent}`;

function crashingHarness(agent = crashingAgent) {
  const directory = mkdtempSync(join(tmpdir(), "mirador-harness-exit-"));
  const script = join(directory, "crashing-agent.js");
  writeFileSync(script, agent);
  return new HarnessProcess(
    { id: "opencode", label: "Crashing agent", logName: "crashing", command: [process.execPath, script], environment: {}, prelaunch: "", startsOneAtATime: false },
    { onSessionUpdate: () => {}, onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } } as never), onExit: () => {} },
    directory,
  );
}

describe("HarnessProcess.prompt", () => {
  test("fails with how the agent process went away when it dies during the turn, not with a closed connection", async () => {
    const harness = crashingHarness();
    await harness.start();
    const { sessionId } = await harness.newSession({ cwd: tmpdir(), mcpServers: [] });
    await expect(harness.prompt(sessionId, [{ type: "text", text: "hello" }])).rejects.toThrow("The Crashing agent agent process exited with 3.");
  }, 15_000);

  test("fails with how the agent process went away even when its output never ends", async () => {
    const harness = crashingHarness(crashingAgentWhoseChildHoldsItsOutput);
    await harness.start();
    const { sessionId } = await harness.newSession({ cwd: tmpdir(), mcpServers: [] });
    await expect(harness.prompt(sessionId, [{ type: "text", text: "hello" }])).rejects.toThrow("The Crashing agent agent process exited with 3.");
  }, 5_000);

  test("fails with the reason the host gave when it stops the agent during the turn", async () => {
    const harness = crashingHarness();
    await harness.start();
    const { sessionId } = await harness.newSession({ cwd: tmpdir(), mcpServers: [] });
    const prompt = harness.prompt(sessionId, [{ type: "text", text: "hello" }]);
    void harness.stop("was restarted because its profile changed");
    await expect(prompt).rejects.toThrow("The Crashing agent agent process was restarted because its profile changed.");
  }, 15_000);
});
