import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PublicAddress } from "../shared/model.ts";
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
  /** The environment's public address wins over the one in config.json, so Settings can't change it then. */
  publicAddressSetByEnvironment: boolean;
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

function webOrigin(address: unknown, name: string) {
  const url = typeof address === "string" ? URL.parse(address) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error(`${name} must be a web address, like https://box.example.ts.net.`);
  return url.origin;
}

/** Both addresses or neither, each cut down to its origin. */
export function publicAddressOf(origin: unknown, canvasOrigin: unknown, names: { origin: string; canvasOrigin: string }): PublicAddress | null {
  if (!origin && !canvasOrigin) return null;
  if (!origin || !canvasOrigin) throw new Error(`Set both ${names.origin} and ${names.canvasOrigin}, or neither.`);
  return { origin: webOrigin(origin, names.origin), canvasOrigin: webOrigin(canvasOrigin, names.canvasOrigin) };
}

const publicAddressInEnvironment = (env: NodeJS.ProcessEnv) =>
  publicAddressOf(env.MIRADOR_PUBLIC_ORIGIN, env.MIRADOR_PUBLIC_CANVAS_ORIGIN, { origin: "MIRADOR_PUBLIC_ORIGIN", canvasOrigin: "MIRADOR_PUBLIC_CANVAS_ORIGIN" });

export const configFilePath = (dataDir: string) => join(dataDir, "config.json");

function readConfigFile(dataDir: string): Record<string, unknown> {
  const path = configFilePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof settings === "object" && settings !== null && !Array.isArray(settings)) return settings as Record<string, unknown>;
  } catch {}
  throw new Error(`${path} must hold a JSON object, like {"publicOrigin": "https://…", "publicCanvasOrigin": "https://…"}.`);
}

/** The public address saved in config.json, by hand or from Settings. */
export function savedPublicAddress(dataDir: string) {
  const { publicOrigin, publicCanvasOrigin } = readConfigFile(dataDir);
  try {
    return publicAddressOf(publicOrigin, publicCanvasOrigin, { origin: "publicOrigin", canvasOrigin: "publicCanvasOrigin" });
  } catch (error) {
    throw new Error(`${configFilePath(dataDir)}: ${(error as Error).message}`);
  }
}

/** Keeps whatever else config.json holds; the host uses the new address from its next start. */
export function savePublicAddress(dataDir: string, address: PublicAddress | null) {
  const { publicOrigin: _origin, publicCanvasOrigin: _canvasOrigin, ...otherSettings } = readConfigFile(dataDir);
  const settings = address ? { ...otherSettings, publicOrigin: address.origin, publicCanvasOrigin: address.canvasOrigin } : otherSettings;
  writeFileSync(configFilePath(dataDir), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function loadConfig(env = process.env): HostConfig {
  const port = Number(env.MIRADOR_PORT ?? 4600);
  const canvasAssetsPort = Number(env.MIRADOR_CANVAS_PORT ?? port + 1);
  const dataDir = env.MIRADOR_DATA_DIR ?? join(homedir(), ".mirador");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const publicAddressFromEnvironment = publicAddressInEnvironment(env);
  const publicAt = publicAddressFromEnvironment ?? savedPublicAddress(dataDir);
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
    canvasAssetsOrigin: publicAt?.canvasOrigin ?? `http://127.0.0.1:${canvasAssetsPort}`,
    publicAddressSetByEnvironment: publicAddressFromEnvironment !== null,
    notifierDir: env.MIRADOR_NOTIFIER_DIR ?? notifierDirIfInstalled(),
    testModelOverride: { model: env.MIRADOR_TEST_MODEL, effort: env.MIRADOR_TEST_EFFORT },
    developmentMode: env.MIRADOR_DEV === "1",
    runsUserStatusLine: env.MIRADOR_STATUSLINE !== "off",
  };
}
