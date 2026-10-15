import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine, commandShell, findGitBash, findPowerShell, powershellInvocation } from "../host/command-shell.ts";

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const withGitBash = { gitBash: () => gitBash, powershell: () => "pwsh.exe" };
const withoutGitBash = { gitBash: () => null, powershell: () => "powershell.exe" };
const powershell = (program: string) => (command: string) => commandLine({ kind: "powershell", program }, command);

describe("a command string", () => {
  test("runs on the Mac and Linux in the shell its caller names, a login shell when asked", () => {
    expect(commandLine(commandShell(() => "/bin/zsh", {}, { platform: "darwin" }), "ls", { login: true })).toEqual(["/bin/zsh", "-lc", "ls"]);
    expect(commandLine(commandShell(() => "sh", {}, { platform: "linux" }), "ls")).toEqual(["sh", "-c", "ls"]);
  });

  test("runs on Windows in Git Bash, as Claude Code runs it, without asking for a Unix shell", () => {
    const noUnixShell = () => {
      throw new Error("process.getuid is not a function");
    };
    expect(commandLine(commandShell(noUnixShell, {}, { platform: "win32", windows: withGitBash }), "ls", { login: true })).toEqual([gitBash, "-lc", "ls"]);
    expect(commandLine(commandShell(noUnixShell, {}, { platform: "win32", windows: withGitBash }), "ls")).toEqual([gitBash, "-c", "ls"]);
  });

  test("runs on Windows without Git Bash in PowerShell, keeping the command's own exit code, and reads the profile only for a login", () => {
    const shell = commandShell(() => "sh", {}, { platform: "win32", windows: withoutGitBash });
    expect(shell).toEqual({ kind: "powershell", program: "powershell.exe" });
    const [program, ...args] = powershell("powershell.exe")("cmd /c exit 3");
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args.at(-1)).toContain("cmd /c exit 3\nif (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }");
    expect(commandLine(shell, "ls", { login: true })).not.toContain("-NoProfile");
  });

  test("runs on Windows in the Git Bash its own environment names, as the agent started with it finds it, not the host's", () => {
    const bash = join(mkdtempSync(join(tmpdir(), "mirador-git-bash-")), "bash");
    writeFileSync(bash, "");
    expect(process.env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
    expect(commandShell(() => "sh", { CLAUDE_CODE_GIT_BASH_PATH: bash }, { platform: "win32" })).toEqual({ kind: "posix", program: bash });
  });
});

describe("Git Bash", () => {
  const existing = (...paths: string[]) => (path: string) => paths.includes(path);
  const noGit = () => null;

  test("is found where Claude Code looks: CLAUDE_CODE_GIT_BASH_PATH when it names a bash that exists", () => {
    const custom = "D:\\Tools\\Git\\bin\\bash.exe";
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: custom }, existing(custom, gitBash), noGit)).toBe(custom);
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\Tools\\Git\\git-bash.exe" }, existing("D:\\Tools\\Git\\git-bash.exe", gitBash), noGit)).toBe(gitBash);
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: custom }, existing(gitBash), noGit)).toBe(gitBash);
  });

  test("is found next in Git's install folders, then beside the git on PATH", () => {
    const x86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
    expect(findGitBash({}, existing(x86), noGit)).toBe(x86);
    const scoop = "C:\\Users\\me\\scoop\\apps\\git\\current";
    expect(findGitBash({}, existing(`${scoop}\\bin\\bash.exe`), () => `${scoop}\\cmd\\git.exe`)).toBe(`${scoop}\\bin\\bash.exe`);
    expect(findGitBash({}, existing(`${scoop}\\bin\\bash.exe`), () => `${scoop}\\mingw64\\bin\\git.exe`)).toBe(`${scoop}\\bin\\bash.exe`);
    expect(findGitBash({}, existing(), noGit)).toBeNull();
  });
});

test("PowerShell 7 is preferred when installed, else Windows PowerShell", () => {
  expect(findPowerShell({}, (program) => (program === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null))).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  expect(findPowerShell({}, (program) => (program === "powershell" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : null))).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(findPowerShell({}, () => null)).toBe("powershell.exe");
});

test("a program and its arguments reach PowerShell as they are, quotes included", () => {
  expect(powershellInvocation(["C:\\Program Files\\claude.exe", "auth", "it's"])).toBe("& 'C:\\Program Files\\claude.exe' 'auth' 'it''s'");
});
