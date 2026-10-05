/**
 * Electrobun's postBuild hook. Its config offers no way to add this Info.plist key, which gives the prompt macOS shows
 * when Mirador's terminal or agents first reach a machine on the local network.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const LOCAL_NETWORK_USAGE = "Mirador's terminal and agents reach machines on your local network.";

function builtApp(buildDir: string) {
  const app = readdirSync(buildDir).find((entry) => entry.endsWith(".app"));
  if (!app) throw new Error(`No app bundle in ${buildDir}`);
  return join(buildDir, app);
}

if (process.env.ELECTROBUN_OS === "macos") {
  const infoPlist = join(builtApp(process.env.ELECTROBUN_BUILD_DIR!), "Contents", "Info.plist");
  execFileSync("plutil", ["-replace", "NSLocalNetworkUsageDescription", "-string", LOCAL_NETWORK_USAGE, infoPlist]);
}
