import { RequestError } from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { harnessIds, harnessLabels, type CanvasUse, type HarnessId, type Profile } from "../../shared/model.ts";
import { canvasUseGuidance } from "../canvas/guidance.ts";
import { jobWaitGuidance } from "../job-waits.ts";
import { applyEnvironment, parseEnvironment } from "../../shared/profile-environment.ts";
import { claudeProgramMissing, findClaudeProgram } from "./claude-program.ts";
import { agentEnvironment } from "./environment.ts";
import type { HarnessSpec } from "./harness.ts";
import { commandShell, powershellInvocation } from "../command-shell.ts";

const claudeAgentEntry = join(
  dirname(Bun.resolveSync("@agentclientprotocol/claude-agent-acp/package.json", import.meta.dir)),
  "dist/index.js",
);

/** Where opencode's installers put it, for hosts started without a login shell's PATH (e.g. by launchd). */
const opencodeInstallDirectories = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".opencode", "bin")];

const findOpencode = () => Bun.which("opencode") ?? Bun.which("opencode", { PATH: opencodeInstallDirectories.join(delimiter) });

function opencodeCommand(): string[] {
  const executable = findOpencode();
  if (!executable) throw new Error("opencode is not installed: no opencode executable on PATH or in its usual install directories.");
  return [executable, "acp"];
}

/** The agents this machine has a program for. */
export function installedHarnesses(claudeProgramSetting: string): HarnessId[] {
  const programOf: Record<HarnessId, () => string | null> = { claude: () => findClaudeProgram(claudeProgramSetting), opencode: findOpencode };
  return harnessIds.filter((harness) => programOf[harness]() !== null);
}

const commandFor: Record<HarnessId, () => string[]> = {
  claude: () => [process.execPath, claudeAgentEntry],
  opencode: opencodeCommand,
};

const AUTH_REQUIRED_CODE = RequestError.authRequired().code;

/** The agent refuses prompts until the user signs in again. */
export const isAuthRequiredError = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED_CODE;

/** Each harness's own sign-in, run by the program the agent runs, so it signs in that installation. */
const loginCommandFor: Record<HarnessId, (environment: Record<string, string>) => string[]> = {
  claude: (environment) => [environment.CLAUDE_CODE_EXECUTABLE!, "auth", "login"],
  opencode: () => [opencodeCommand()[0]!, "auth", "login"],
};

const powershellKeepOpenOnFailure = (command: string[]) =>
  [
    powershellInvocation(command),
    "if ($?) { exit 0 }",
    "$status = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }",
    'Write-Host -NoNewline "`nSigning in ended with status $status. Press Enter to close this tab."',
    "[void][Console]::ReadLine()",
    "exit $status",
  ].join("\n");

/**
 * A failed sign-in keeps its tab open until Enter, so its output can be read; one that worked closes it. The command
 * comes in as arguments, so nothing in it is quoted for the shell.
 */
export function loginCommand(harness: HarnessId, environment: Record<string, string>, shell = commandShell(() => "/bin/sh", environment)): string[] {
  const signIn = loginCommandFor[harness](environment);
  if (shell.kind === "powershell") return [shell.program, "-NoLogo", "-NoProfile", "-Command", powershellKeepOpenOnFailure(signIn)];
  const keepOpenOnFailure = '"$@" && exit 0; status=$?; printf "\\nSigning in ended with status %s. Press Enter to close this tab." "$status"; read -r _; exit "$status"';
  return [shell.program, "-c", keepOpenOnFailure, "mirador-login", ...signIn];
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The profile's environment goes on the agent process itself, not on the session:
 * claude-agent-acp picks a session's model from its own ANTHROPIC_MODEL, and opencode
 * reads its configuration (OPENCODE_CONFIG_CONTENT, XDG_CONFIG_HOME, ...) at startup.
 */
export function harnessSpec(profile: Profile, claudeProgramSetting: string): HarnessSpec {
  const { harness } = profile;
  return {
    id: harness,
    command: commandFor[harness](),
    startsOneAtATime: harness === "opencode",
    label: `${harnessLabels[harness]} (${profile.name})`,
    logName: `${harness}-${slug(profile.name) || "profile"}-${profile.id.slice(0, 8)}`,
    environment: launchEnvironment(harness, profile, claudeProgramSetting),
    prelaunch: profile.prelaunch,
  };
}

export const CANVAS_SERVER_NAME = "canvas";

const opencodeCanvasPlugin = { package: join(import.meta.dir, "opencode-canvas-plugin"), options: { server: CANVAS_SERVER_NAME } };

/**
 * opencode 2 loads the plugin that gives the agent the canvas tools themselves, after the profile's own plugins; opencode 1
 * ignores `plugins`. A configuration that is not plain JSON, such as JSONC with comments, stays as it is, and the agent
 * reaches the canvas tools through Code Mode.
 */
function withCanvasToolsPlugin(environment: Record<string, string>): Record<string, string> {
  const config: unknown = (() => {
    try {
      return JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}");
    } catch {
      return null;
    }
  })();
  if (typeof config !== "object" || config === null || Array.isArray(config)) return environment;
  const { plugins = [] } = config as { plugins?: unknown };
  if (!Array.isArray(plugins)) return environment;
  return { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...plugins, opencodeCanvasPlugin] }) };
}

/**
 * The agent's environment, with the profile's on top. claude-agent-acp runs the Claude Code in CLAUDE_CODE_EXECUTABLE
 * rather than the copy its SDK bundles; a profile may name its own.
 */
export function launchEnvironment(harness: HarnessId, profile: Profile | null, claudeProgramSetting: string): Record<string, string> {
  const environment = profileEnvironment(profile);
  if (harness === "opencode") return withCanvasToolsPlugin(environment);
  if (environment.CLAUDE_CODE_EXECUTABLE) return environment;
  const program = findClaudeProgram(claudeProgramSetting, environment.PATH);
  if (!program) throw new Error(claudeProgramMissing(claudeProgramSetting));
  return { ...environment, CLAUDE_CODE_EXECUTABLE: program };
}

export function profileEnvironment(profile: Profile | null): Record<string, string> {
  if (!profile) return agentEnvironment();
  const environment = parseEnvironment(profile.environment);
  if (environment.errors.length > 0) {
    throw new Error(`Profile "${profile.name}" has an invalid environment: ${environment.errors.join("; ")}`);
  }
  return applyEnvironment(agentEnvironment(), environment);
}

/** None of them changes files or runs commands for the agent, so none is worth a permission prompt. */
const PRE_ALLOWED_CANVAS_TOOLS = ["show", "ask", "tour", "review", "update_review", "checklist", "update_checklist", "when_done"];

/**
 * Session options Claude Code reads from `_meta.claudeCode.options` (claude-agent-acp).
 * AskUserQuestion is disabled so questions go through the visual `ask` tool instead.
 * opencode needs nothing: it offers no question tool over ACP, and the user's own
 * opencode permission settings apply unchanged.
 */
export function sessionMeta(harness: HarnessId, canvasUse: CanvasUse, { withoutUserSettings = false } = {}) {
  if (harness !== "claude") return undefined;
  return {
    systemPrompt: { append: [...(canvasUse === "often" ? [canvasUseGuidance] : []), jobWaitGuidance].join("\n\n") },
    claudeCode: {
      options: {
        ...(withoutUserSettings && { settingSources: ["project", "local"] }),
        env: { CLAUDE_NOTIFIER: "0" },
        allowedTools: PRE_ALLOWED_CANVAS_TOOLS.map((tool) => `mcp__${CANVAS_SERVER_NAME}__${tool}`),
        disallowedTools: ["AskUserQuestion"],
      },
    },
  };
}
