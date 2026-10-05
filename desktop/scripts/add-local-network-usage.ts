#!/usr/bin/env bun
/**
 * Adds NSLocalNetworkUsageDescription to Info.plist and re-signs the app ad hoc.
 * Run automatically after electrobun build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LOCAL_NETWORK_USAGE = "This app requires local network access to connect to local services.";

function findBuiltApps(buildDir: string): string[] {
  if (!existsSync(buildDir)) return [];
  return readdirSync(buildDir)
    .filter((entry) => entry.endsWith(".app"))
    .map((entry) => join(buildDir, entry));
}

if (process.platform === "darwin") {
  const targets = new Set<string>();

  if (process.env.ELECTROBUN_BUILD_DIR) {
    for (const app of findBuiltApps(process.env.ELECTROBUN_BUILD_DIR)) {
      targets.add(app);
    }
  }

  const buildBase = join(import.meta.dirname, "..", "build");
  if (existsSync(buildBase)) {
    for (const sub of readdirSync(buildBase)) {
      for (const app of findBuiltApps(join(buildBase, sub))) {
        targets.add(app);
      }
    }
  }

  for (const app of targets) {
    const infoPlist = join(app, "Contents", "Info.plist");
    if (existsSync(infoPlist)) {
      execFileSync("plutil", ["-replace", "NSLocalNetworkUsageDescription", "-string", LOCAL_NETWORK_USAGE, infoPlist]);
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", app]);
    }
  }
}
