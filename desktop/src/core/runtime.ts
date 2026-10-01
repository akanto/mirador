import { join } from "node:path";

export const DEFAULT_PORT = 4600;

type Environment = Record<string, string | undefined>;

export interface Runtime {
  port: number;
  canvasPort: number;
  dataDir: string;
  origin: string;
  canvasOrigin: string;
}

function portFrom(value: string | undefined, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

const defaultDataDir = (home: string) => join(home, ".visualized-sessions");

export function resolveRuntime(env: Environment, home: string): Runtime {
  const port = portFrom(env.VCS_PORT, DEFAULT_PORT);
  const canvasPort = portFrom(env.VCS_CANVAS_PORT, port + 1);
  return {
    port,
    canvasPort,
    dataDir: env.VCS_DATA_DIR || defaultDataDir(home),
    origin: `http://127.0.0.1:${port}`,
    canvasOrigin: `http://127.0.0.1:${canvasPort}`,
  };
}

/** Only what differs from the host's own defaults, so the real app passes the host nothing. */
export function hostEnvironmentOverrides(runtime: Runtime, home: string): Record<string, string> {
  return {
    ...(runtime.port !== DEFAULT_PORT && { VCS_PORT: String(runtime.port) }),
    ...(runtime.canvasPort !== runtime.port + 1 && { VCS_CANVAS_PORT: String(runtime.canvasPort) }),
    ...(runtime.dataDir !== defaultDataDir(home) && { VCS_DATA_DIR: runtime.dataDir }),
  };
}

export interface DataPaths {
  settings: string;
  ownedHostPid: string;
  hostLog: string;
  browserToken: string;
}

export const dataPaths = (dataDir: string): DataPaths => ({
  settings: join(dataDir, "desktop.json"),
  ownedHostPid: join(dataDir, "desktop-host.pid"),
  hostLog: join(dataDir, "logs", "host.log"),
  browserToken: join(dataDir, "browser-token"),
});

export const authUrl = (runtime: Runtime, token: string) => `${runtime.origin}/auth?token=${token}`;
