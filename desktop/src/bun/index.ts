import Electrobun, { PATHS, Utils } from "electrobun/main";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountShell } from "../../../shared/login-shell.ts";
import { installedAppPath } from "../core/app-bundle.ts";
import { loginShell } from "../core/host-command.ts";
import { dataPaths, resolveRuntime } from "../core/runtime.ts";
import { SettingsStore } from "../core/settings.ts";
import { claimSingleInstance } from "../core/single-instance.ts";
import { recordStartupFailure } from "../core/startup-failure.ts";
import { installApplicationMenu } from "./app-menu.ts";
import { DesktopApp } from "./desktop-app.ts";

const APP_NAME = "Mirador";

const home = homedir();
const runtime = resolveRuntime(process.env, home);
const paths = dataPaths(runtime.dataDir);

const miradorInsideApp = { hostDirectory: join(PATHS.RESOURCES_FOLDER, "app", "mirador"), bun: process.execPath };

let app: DesktopApp | undefined;

async function isLaunchedAgain() {
  if (process.platform === "darwin") return false;
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
    appPath: installedAppPath(process.execPath),
    isPackaged: Electrobun.app.isPackaged,
    builtFromCode: BUILD_DESKTOP_APP_CODE,
  });

  if (process.platform === "darwin") installApplicationMenu(APP_NAME, () => app?.closeWhatHasFocus());
  Electrobun.events.on("reopen", () => void app?.openWindow());
  Electrobun.events.on("before-quit", () => app?.stopOwnedHost());
  await app.start();
}

async function tellStartupFailed(error: unknown) {
  const notice = recordStartupFailure(APP_NAME, error, paths.desktopLog);
  await Utils.showMessageBox({ type: "error", ...notice, buttons: ["OK"] });
  Utils.quit();
}

try {
  if (await isLaunchedAgain()) Utils.quit();
  else await launch();
} catch (error) {
  await tellStartupFailed(error);
}
