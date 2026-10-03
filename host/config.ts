import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { relayPorts } from "../shared/relay-ports.ts";

export interface HostConfig {
  port: number;
  canvasAssetsPort: number;
  relayPorts: number[];
  dataDir: string;
  databasePath: string;
  browserToken: string;
  mcpToken: string;
  /** Lets scripts an agent started post messages back to its conversation; kept across restarts so waiting scripts still get through. */
  scriptToken: string;
  appOrigin: string;
  /** Where other devices reach this host, e.g. through tailscale serve, while it listens on 127.0.0.1 only; null when only this machine does. */
  publicOrigin: string | null;
  /** Where canvas pages load D3, Mermaid and three from: the public one when there is one, so the agents' pages load for every viewer. */
  canvasAssetsOrigin: string;
  notifierDir: string | null;
  /** Test runs pin a cheap model; profiles are left alone because a profile chooses its own model. */
  testModelOverride: { model?: string; effort?: string };
  /** Hot reload makes open pages swap modules mid-conversation, so it is opt-in for working on the UI itself. */
  developmentMode: boolean;
  /** Runs the statusline command from the user's Claude Code settings; test hosts turn it off with MIRADOR_STATUSLINE=off. */
  runsUserStatusLine: boolean;
}

function loadOrCreateToken(dataDir: string, fileName: string) {
  const tokenFile = join(dataDir, fileName);
  if (existsSync(tokenFile)) return readFileSync(tokenFile, "utf8").trim();
  const token = crypto.randomUUID().replaceAll("-", "");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

function notifierDirIfInstalled() {
  const dir = join(homedir(), ".config", "claude-notifier");
  return existsSync(dir) ? dir : null;
}

function publicAddress({ MIRADOR_PUBLIC_ORIGIN: origin, MIRADOR_PUBLIC_CANVAS_ORIGIN: canvasOrigin }: NodeJS.ProcessEnv) {
  if (!origin && !canvasOrigin) return null;
  if (!origin || !canvasOrigin) throw new Error("Set both MIRADOR_PUBLIC_ORIGIN and MIRADOR_PUBLIC_CANVAS_ORIGIN, or neither.");
  return { origin: new URL(origin).origin, canvasAssetsOrigin: new URL(canvasOrigin).origin };
}

export function loadConfig(env = process.env): HostConfig {
  const port = Number(env.MIRADOR_PORT ?? 4600);
  const canvasAssetsPort = Number(env.MIRADOR_CANVAS_PORT ?? port + 1);
  const dataDir = env.MIRADOR_DATA_DIR ?? join(homedir(), ".mirador");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const publicAt = publicAddress(env);
  return {
    port,
    canvasAssetsPort,
    relayPorts: relayPorts(port),
    dataDir,
    databasePath: join(dataDir, "state.sqlite"),
    browserToken: loadOrCreateToken(dataDir, "browser-token"),
    mcpToken: env.MIRADOR_MCP_TOKEN ?? crypto.randomUUID().replaceAll("-", ""),
    scriptToken: loadOrCreateToken(dataDir, "script-token"),
    appOrigin: `http://127.0.0.1:${port}`,
    publicOrigin: publicAt?.origin ?? null,
    canvasAssetsOrigin: publicAt?.canvasAssetsOrigin ?? `http://127.0.0.1:${canvasAssetsPort}`,
    notifierDir: env.MIRADOR_NOTIFIER_DIR ?? notifierDirIfInstalled(),
    testModelOverride: { model: env.MIRADOR_TEST_MODEL, effort: env.MIRADOR_TEST_EFFORT },
    developmentMode: env.MIRADOR_DEV === "1",
    runsUserStatusLine: env.MIRADOR_STATUSLINE !== "off",
  };
}
