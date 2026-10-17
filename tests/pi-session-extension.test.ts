import { expect, test } from "bun:test";

const sessionExtensionModule = "pi-acp/dist/session-extension.js";
const { default: sessionExtension } = (await import(sessionExtensionModule)) as { default: (pi: object) => void };

test("Mirador's pi extension turns down a pi older than 0.99.0, which has no MCP servers to give the canvas to", () => {
  expect(() => sessionExtension({ on: () => {} })).toThrow("Mirador needs pi 0.99.0 or later. Update pi with npm install -g @earendil-works/pi-coding-agent");
});
