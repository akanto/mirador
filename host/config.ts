import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostConfig {
  port: number;
  canvasAssetsPort: number;
  dataDir: string;
  databasePath: string;
  browserToken: string;
  mcpToken: string;
  appOrigin: string;
  canvasAssetsOrigin: string;
  notifierDir: string | null;
  /** Test runs pin a cheap model; profiles are left alone because a profile chooses its own model. */
  testModelOverride: { model?: string; effort?: string };
  /** Hot reload makes open pages swap modules mid-conversation, so it is opt-in for working on the UI itself. */
  developmentMode: boolean;
  /** Runs the statusline command from the user's Claude Code settings; test hosts turn it off with MIRADOR_STATUSLINE=off. */
  runsUserStatusLine: boolean;
}

function loadOrCreateBrowserToken(dataDir: string) {
  const tokenFile = join(dataDir, "browser-token");
  if (existsSync(tokenFile)) return readFileSync(tokenFile, "utf8").trim();
  const token = crypto.randomUUID().replaceAll("-", "");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

function notifierDirIfInstalled() {
  const dir = join(homedir(), ".config", "claude-notifier");
  return existsSync(dir) ? dir : null;
}

export function loadConfig(env = process.env): HostConfig {
  const port = Number(env.MIRADOR_PORT ?? 4600);
  const canvasAssetsPort = Number(env.MIRADOR_CANVAS_PORT ?? port + 1);
  const dataDir = env.MIRADOR_DATA_DIR ?? join(homedir(), ".mirador");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return {
    port,
    canvasAssetsPort,
    dataDir,
    databasePath: join(dataDir, "state.sqlite"),
    browserToken: loadOrCreateBrowserToken(dataDir),
    mcpToken: env.MIRADOR_MCP_TOKEN ?? crypto.randomUUID().replaceAll("-", ""),
    appOrigin: `http://127.0.0.1:${port}`,
    canvasAssetsOrigin: `http://127.0.0.1:${canvasAssetsPort}`,
    notifierDir: env.MIRADOR_NOTIFIER_DIR ?? notifierDirIfInstalled(),
    testModelOverride: { model: env.MIRADOR_TEST_MODEL, effort: env.MIRADOR_TEST_EFFORT },
    developmentMode: env.MIRADOR_DEV === "1",
    runsUserStatusLine: env.MIRADOR_STATUSLINE !== "off",
  };
}
