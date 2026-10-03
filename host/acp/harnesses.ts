import { RequestError } from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { harnessLabels, type CanvasUse, type HarnessId, type Profile } from "../../shared/model.ts";
import { canvasUseGuidance } from "../canvas/guidance.ts";
import { jobWaitGuidance } from "../job-waits.ts";
import { applyEnvironment, parseEnvironment } from "../../shared/profile-environment.ts";
import { agentEnvironment } from "./environment.ts";
import type { HarnessSpec } from "./harness.ts";

const claudeAgentEntry = join(
  dirname(Bun.resolveSync("@agentclientprotocol/claude-agent-acp/package.json", import.meta.dir)),
  "dist/index.js",
);

/** Where opencode's installers put it, for hosts started without a login shell's PATH (e.g. by launchd). */
const opencodeInstallDirectories = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".opencode", "bin")];

function opencodeCommand(): string[] {
  const executable = Bun.which("opencode") ?? Bun.which("opencode", { PATH: opencodeInstallDirectories.join(":") });
  if (!executable) throw new Error("opencode is not installed: no opencode executable on PATH or in its usual install directories.");
  return [executable, "acp"];
}

const commandFor: Record<HarnessId, () => string[]> = {
  claude: () => [process.execPath, claudeAgentEntry],
  opencode: opencodeCommand,
};

const AUTH_REQUIRED_CODE = RequestError.authRequired().code;

/** The agent refuses prompts until the user signs in again. */
export const isAuthRequiredError = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED_CODE;

/** Claude Code's own sign-in, run by claude-agent-acp's bundled CLI so it signs in the same installation the agent uses. */
const loginCommandFor: Record<HarnessId, () => string[]> = {
  claude: () => [process.execPath, claudeAgentEntry, "--cli", "auth", "login"],
  opencode: () => [opencodeCommand()[0]!, "auth", "login"],
};

/**
 * A failed sign-in keeps its tab open until Enter, so its output can be read; one that worked closes it. The command
 * comes in as arguments, so nothing in it is quoted for the shell.
 */
export function loginCommand(harness: HarnessId): string[] {
  const keepOpenOnFailure = '"$@" && exit 0; status=$?; printf "\\nSigning in ended with status %s. Press Enter to close this tab." "$status"; read -r _; exit "$status"';
  return ["/bin/sh", "-c", keepOpenOnFailure, "mirador-login", ...loginCommandFor[harness]()];
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The profile's environment goes on the agent process itself, not on the session:
 * claude-agent-acp picks a session's model from its own ANTHROPIC_MODEL, and opencode
 * reads its configuration (OPENCODE_CONFIG_CONTENT, XDG_CONFIG_HOME, ...) at startup.
 */
export function harnessSpec(harness: HarnessId, profile: Profile | null): HarnessSpec {
  const command = commandFor[harness]();
  const common = { id: harness, command, startsOneAtATime: harness === "opencode" };
  if (!profile) {
    return { ...common, label: harnessLabels[harness], logName: harness, environment: agentEnvironment(), prelaunch: "" };
  }
  return {
    ...common,
    label: `${harnessLabels[harness]} (${profile.name})`,
    logName: `${harness}-${slug(profile.name) || "profile"}-${profile.id.slice(0, 8)}`,
    environment: profileEnvironment(profile),
    prelaunch: profile.prelaunch,
  };
}

export function profileEnvironment(profile: Profile | null): Record<string, string> {
  if (!profile) return agentEnvironment();
  const environment = parseEnvironment(profile.environment);
  if (environment.errors.length > 0) {
    throw new Error(`Profile "${profile.name}" has an invalid environment: ${environment.errors.join("; ")}`);
  }
  return applyEnvironment(agentEnvironment(), environment);
}

export const CANVAS_SERVER_NAME = "canvas";

/**
 * Session options Claude Code reads from `_meta.claudeCode.options` (claude-agent-acp).
 * AskUserQuestion is disabled so questions go through the visual `ask` tool instead.
 * opencode needs nothing: it offers no question tool over ACP, and the user's own
 * opencode permission settings apply unchanged.
 */
export function sessionMeta(harness: HarnessId, canvasUse: CanvasUse) {
  if (harness !== "claude") return undefined;
  return {
    systemPrompt: { append: [...(canvasUse === "often" ? [canvasUseGuidance] : []), jobWaitGuidance].join("\n\n") },
    claudeCode: {
      options: {
        env: { CLAUDE_NOTIFIER: "0" },
        allowedTools: [`mcp__${CANVAS_SERVER_NAME}__show`, `mcp__${CANVAS_SERVER_NAME}__ask`],
        disallowedTools: ["AskUserQuestion"],
      },
    },
  };
}
