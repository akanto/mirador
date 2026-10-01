import Electrobun from "electrobun/main";
import { homedir, userInfo } from "node:os";
import { appBundlePath } from "../core/app-bundle.ts";
import { loginShell } from "../core/host-command.ts";
import { dataPaths, resolveRuntime } from "../core/runtime.ts";
import { SettingsStore } from "../core/settings.ts";
import { installApplicationMenu } from "./app-menu.ts";
import { DesktopApp } from "./desktop-app.ts";

const APP_NAME = "Visualized Sessions";

const home = homedir();
const runtime = resolveRuntime(process.env, home);
const paths = dataPaths(runtime.dataDir);

const app = new DesktopApp({
  appName: APP_NAME,
  runtime,
  paths,
  settings: new SettingsStore(paths.settings, { hostDirectory: BUILD_HOST_DIRECTORY, bun: BUILD_BUN }),
  shell: loginShell(process.env, userInfo().shell ?? undefined),
  home,
  uid: process.getuid!(),
  appPath: appBundlePath(process.execPath),
  isPackaged: Electrobun.app.isPackaged,
});

installApplicationMenu(APP_NAME);
Electrobun.events.on("reopen", () => void app.openWindow());
Electrobun.events.on("before-quit", () => app.stopOwnedHost());
await app.start();
