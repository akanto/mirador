import Electrobun, { PATHS, Utils } from "electrobun/main";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountShell } from "../../../shared/login-shell.ts";
import { installedAppPath } from "../core/app-bundle.ts";
import { loginShell } from "../core/host-command.ts";
import { dataPaths, resolveRuntime } from "../core/runtime.ts";
import { SettingsStore } from "../core/settings.ts";
import { claimSingleInstance } from "../core/single-instance.ts";
import { installApplicationMenu } from "./app-menu.ts";
import { DesktopApp } from "./desktop-app.ts";

const APP_NAME = "Mirador";

const home = homedir();
const runtime = resolveRuntime(process.env, home);
const paths = dataPaths(runtime.dataDir);

const miradorInsideApp = { hostDirectory: join(PATHS.RESOURCES_FOLDER, "app", "mirador"), bun: process.execPath };

let app: DesktopApp | undefined;

async function isLaunchedAgain() {
  if (process.platform !== "linux") return false;
  const socketPath = join(runtime.dataDir, `desktop-${runtime.port}.sock`);
  return (await claimSingleInstance(socketPath, () => void app?.openWindow())) === null;
}

async function launch() {
  app = new DesktopApp({
    appName: APP_NAME,
    runtime,
    paths,
    settings: new SettingsStore(paths.settings, { hostDirectory: BUILD_HOST_DIRECTORY, bun: BUILD_BUN }, miradorInsideApp),
    shell: loginShell(process.env, accountShell()),
    home,
    configHome: process.env.XDG_CONFIG_HOME || join(home, ".config"),
    uid: process.getuid!(),
    appPath: installedAppPath(process.execPath),
    isPackaged: Electrobun.app.isPackaged,
  });

  if (process.platform === "darwin") installApplicationMenu(APP_NAME, () => void app?.closeWindowAfterAsking());
  Electrobun.events.on("reopen", () => void app?.openWindow());
  Electrobun.events.on("before-quit", () => app?.stopOwnedHost());
  await app.start();
}

if (await isLaunchedAgain()) Utils.quit();
else await launch();
