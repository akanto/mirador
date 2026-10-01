import type { ElectrobunConfig } from "electrobun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const hostDirectory = resolve(import.meta.dir, "..");
const bun = Bun.which("bun") ?? join(homedir(), ".bun", "bin", "bun");

export default {
  app: {
    name: "Visualized Sessions",
    identifier: "com.sodre90.visualized-sessions",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
      define: {
        BUILD_HOST_DIRECTORY: JSON.stringify(hostDirectory),
        BUILD_BUN: JSON.stringify(bun),
      },
    },
    mac: { createDmg: false },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
