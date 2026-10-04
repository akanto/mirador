import type { ElectrobunConfig } from "electrobun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const hostDirectory = resolve(import.meta.dir, "..");
const bun = Bun.which("bun") ?? join(homedir(), ".bun", "bin", "bun");
/** `bun run build:release`: the app carries Mirador, staged by scripts/stage-mirador.sh, instead of running this checkout. */
const carriesMirador = process.env.MIRADOR_DESKTOP_RELEASE === "1";

export default {
  app: {
    name: "Mirador",
    identifier: "com.sodre90.mirador",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
      define: {
        BUILD_HOST_DIRECTORY: JSON.stringify(carriesMirador ? null : hostDirectory),
        BUILD_BUN: JSON.stringify(carriesMirador ? null : bun),
      },
    },
    copy: {
      "assets/tray-icon.png": "views/assets/tray-icon.png",
      "icon.iconset/icon_32x32@2x.png": "views/assets/app-icon.png",
      ...(carriesMirador && { "release/mirador": "mirador" }),
    },
    mac: { createDmg: false, icons: "icon.iconset" },
    linux: { icon: "icon.iconset/icon_512x512.png" },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
