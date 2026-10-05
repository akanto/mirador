import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { agentEnvironment, miradorCommandEnvironment } from "../host/acp/environment.ts";

test("the variables of a session the host was started from stay out of its agents and terminals", () => {
  const inherited = {
    PATH: "/usr/bin",
    MIRADOR_PORT: "4700",
    CMUX_SURFACE_ID: "surface",
    CLAUDE_CODE_SESSION_ID: "outer-session",
    MIRADOR_URL: "http://127.0.0.1:4600",
    MIRADOR_SCRIPT_TOKEN: "outer-token",
    CLAUDE_CODE_EXECUTABLE: "/outer/claude",
  };
  expect(agentEnvironment(inherited)).toEqual({ PATH: "/usr/bin", MIRADOR_PORT: "4700" });
});

test("the mirador command comes last on the agent's PATH and runs on the host's Bun, also where no Bun is on the PATH", () => {
  const environment = miradorCommandEnvironment("/usr/bin:/bin");
  expect(environment.PATH).toBe(`/usr/bin:/bin:${join(import.meta.dir, "..", "bin")}`);
  expect(miradorCommandEnvironment(environment.PATH).PATH).toBe(environment.PATH);
  const help = spawnSync("mirador", ["--help"], { env: { ...environment, HOME: "/nonexistent" }, encoding: "utf8" });
  expect(help.stderr).not.toContain("Bun not found");
  expect(help.status).toBe(0);
});
