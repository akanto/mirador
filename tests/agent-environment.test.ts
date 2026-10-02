import { expect, test } from "bun:test";
import { agentEnvironment } from "../host/acp/environment.ts";

test("the variables of a session the host was started from stay out of its agents and terminals", () => {
  const inherited = {
    PATH: "/usr/bin",
    MIRADOR_PORT: "4700",
    CMUX_SURFACE_ID: "surface",
    CLAUDE_CODE_SESSION_ID: "outer-session",
    MIRADOR_URL: "http://127.0.0.1:4600",
    MIRADOR_SCRIPT_TOKEN: "outer-token",
  };
  expect(agentEnvironment(inherited)).toEqual({ PATH: "/usr/bin", MIRADOR_PORT: "4700" });
});
