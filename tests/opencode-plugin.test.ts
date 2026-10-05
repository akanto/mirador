import { expect, test } from "bun:test";
import { withMiradorPlugin } from "../host/acp/harnesses.ts";
import { MiradorPlugin } from "../host/acp/opencode-plugin.ts";
import { jobWaitGuidance } from "../host/job-waits.ts";

const miradorPlugin = expect.stringMatching(/^file:\/\/.*\/host\/acp\/opencode-plugin\.ts$/);
const configOf = (environment: Record<string, string>) => JSON.parse(environment.OPENCODE_CONFIG_CONTENT!);

test("opencode loads Mirador's plugin next to the ones a profile's own configuration names", () => {
  expect(configOf(withMiradorPlugin({ PATH: "/bin" }))).toEqual({ plugin: [miradorPlugin] });
  const profiles = `{
    // the profile's own
    "model": "e2e/scripted",
    "plugin": ["opencode-wakatime"],
  }`;
  expect(configOf(withMiradorPlugin({ OPENCODE_CONFIG_CONTENT: profiles }))).toEqual({ model: "e2e/scripted", plugin: ["opencode-wakatime", miradorPlugin] });
  expect(withMiradorPlugin({ OPENCODE_CONFIG_CONTENT: "{ not json" })).toEqual({ OPENCODE_CONFIG_CONTENT: "{ not json" });
});

test("the plugin gives the agent's commands their session id and tells the agent about mirador when-done", async () => {
  const hooks = await MiradorPlugin();
  const shell = { env: {} as Record<string, string> };
  await hooks["shell.env"]({ sessionID: "ses_123" }, shell);
  expect(shell.env).toEqual({ MIRADOR_SESSION_ID: "ses_123" });
  const prompt = { system: ["You are opencode."] };
  await hooks["experimental.chat.system.transform"]({}, prompt);
  expect(prompt.system).toEqual(["You are opencode.", jobWaitGuidance]);
});
