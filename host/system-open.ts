import { statSync } from "node:fs";
import { extname } from "node:path";

/** What each system's default action runs rather than shows, beyond what Windows lists in PATHEXT and what is executable elsewhere. */
const programExtensions = {
  darwin: [".app", ".command", ".tool", ".terminal", ".workflow", ".action", ".pkg", ".mpkg", ".jar", ".webloc", ".inetloc", ".fileloc"],
  win32: [".lnk", ".url", ".scr", ".pif", ".msi", ".msp", ".hta", ".cpl", ".reg", ".inf", ".ps1", ".jar", ".appref-ms", ".application", ".scf", ".appx", ".msix", ".appinstaller"],
  other: [".desktop", ".jar", ".appimage"],
};

const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

export function isProgram(file: string, platform: NodeJS.Platform = process.platform, environment: Record<string, string | undefined> = process.env) {
  const extension = extname(file).toLowerCase();
  if (platform === "win32") {
    const pathext = (environment.PATHEXT || WINDOWS_DEFAULT_PATHEXT).toLowerCase().split(";").filter(Boolean);
    return pathext.includes(extension) || programExtensions.win32.includes(extension);
  }
  if (programExtensions[platform === "darwin" ? "darwin" : "other"].includes(extension)) return true;
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats?.isFile() === true && (stats.mode & 0o111) !== 0;
}

/** On Windows the path goes in through the environment, as cmd's start would take an & in a file name for the start of another command. */
export function systemOpenCommand(file: string, platform: NodeJS.Platform = process.platform): { command: string[]; environment: Record<string, string> } {
  if (platform === "darwin") return { command: ["open", file], environment: {} };
  if (platform === "win32")
    return { command: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Invoke-Item -LiteralPath $env:MIRADOR_OPEN_FILE"], environment: { MIRADOR_OPEN_FILE: file } };
  return { command: ["xdg-open", file], environment: {} };
}

export function openWithSystemDefault(file: string) {
  const { command, environment } = systemOpenCommand(file);
  Bun.spawn(command, { env: { ...process.env, ...environment }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}
