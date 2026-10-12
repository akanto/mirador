import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INSTALL_SCRIPT = join(import.meta.dir, "..", "install.sh");
const LINUX_LIBRARIES = ["libgtk-3.so.0", "libwebkit2gtk-4.1.so.0", "libayatana-appindicator3.so.1", "librsvg-2.so.2"];
const REAL_TOOLS = ["curl", "tar", "gzip", "mkdir", "rm", "mv", "mktemp", "cat", "env", "chmod"];

const root = mkdtempSync(join(tmpdir(), "mirador-install-"));
const requested: string[] = [];
/** Each release file the server offers, by name, and where it is on disk. */
const assets = new Map<string, string>();
let server: ReturnType<typeof Bun.serve>;

function writeExecutable(path: string, script: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

function tarOf(folder: string, gzip: boolean) {
  const archive = `${folder}.tar`;
  const tar = Bun.spawnSync(["tar", gzip ? "-czf" : "-cf", archive, "-C", folder, "."]);
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  return archive;
}

/** The ditto stub unpacks a tar, as the test machines may have no zip. */
function macosApp() {
  const folder = join(root, "assets", "macos");
  writeExecutable(join(folder, "Mirador.app", "Contents", "MacOS", "launcher"), "exit 0");
  return tarOf(folder, false);
}

/** Like Electrobun's installer, it puts the app under ~/.local/share; it also reads its input, which must not be the script. */
function linuxSetup(arch: string) {
  const folder = join(root, "assets", `linux-${arch}`);
  writeExecutable(
    join(folder, "installer"),
    [
      "cat >/dev/null",
      'app="$HOME/.local/share/com.sodre90.mirador/stable/app"',
      'mkdir -p "$app/bin"',
      `printf '#!/bin/sh\\n' > "$app/bin/launcher"`,
      'chmod +x "$app/bin/launcher"',
      `printf ${arch} > "$HOME/installed-arch"`,
    ].join("\n"),
  );
  return tarOf(folder, true);
}

beforeAll(() => {
  writeStubs();
  assets.set("Mirador-macos-arm64.zip", macosApp());
  assets.set("Mirador-linux-x64-Setup.tar.gz", linuxSetup("x64"));
  assets.set("Mirador-linux-arm64-Setup.tar.gz", linuxSetup("arm64"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1);
      requested.push(name);
      const asset = assets.get(name);
      return asset ? new Response(Bun.file(asset)) : new Response("Not Found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

type Machine = {
  os: "Darwin" | "Linux";
  arch?: string;
  appleSilicon?: boolean;
  runningFrom?: string;
  libraries?: string[];
  packageManager?: "apt-get" | "dnf";
  display?: boolean;
  agent?: boolean;
  /** MIRADOR_APP_DIR, or null for the script to choose. */
  appDir?: string | null;
};

/** Stubs that record what the script asks of them, written once: macOS checks every new program the first time it runs. */
function writeStubs() {
  const stub = (folder: string, name: string, script = "exit 0") => writeExecutable(join(root, folder, name), `echo "${name} $*" >> "$STUB_CALLS"\n${script}`);
  stub("stubs", "uname", 'case "$1" in -s) echo "$STUB_OS" ;; -m) echo "$STUB_ARCH" ;; esac');
  stub("stubs", "sysctl", 'echo "$STUB_APPLE_SILICON"');
  stub("stubs", "ditto", 'mkdir -p "$4" && tar -xf "$3" -C "$4"');
  stub("stubs", "xattr");
  stub("stubs", "open");
  stub("stubs", "pgrep", 'case "$3" in *"$STUB_RUNNING_FROM"*) [ -n "$STUB_RUNNING_FROM" ] && exit 0 ;; esac\nexit 1');
  stub("stubs", "ldconfig", 'for library in $STUB_LIBRARIES; do printf "\\t%s (libc6) => /usr/lib/%s\\n" "$library" "$library"; done');
  stub("stubs", "id", "echo 1000");
  stub("stubs", "sudo");
  stub("apt-get", "apt-get");
  stub("dnf", "dnf");
  stub("agent", "claude");
  REAL_TOOLS.forEach((tool) => {
    mkdirSync(join(root, "tools"), { recursive: true });
    symlinkSync(Bun.which(tool)!, join(root, "tools", tool));
  });
}

let machines = 0;

function machineOf({ os, arch = "arm64", appleSilicon = true, runningFrom = "", libraries = LINUX_LIBRARIES, packageManager, display = true, agent = true, appDir }: Machine) {
  const folder = join(root, `machine-${++machines}`);
  const [home, temp] = ["home", "tmp"].map((name) => join(folder, name));
  const appDirectory = appDir === undefined ? join(home, "Applications") : appDir;
  [home, temp].forEach((path) => mkdirSync(path, { recursive: true }));
  const calls = join(folder, "calls.log");
  writeFileSync(calls, "");
  const path = ["stubs", ...(packageManager ? [packageManager] : []), ...(agent ? ["agent"] : []), "tools"].map((name) => join(root, name));
  const environment = {
    PATH: path.join(":"),
    HOME: home,
    TMPDIR: temp,
    MIRADOR_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`,
    STUB_CALLS: calls,
    STUB_OS: os,
    STUB_ARCH: arch,
    STUB_APPLE_SILICON: appleSilicon ? "1" : "0",
    STUB_RUNNING_FROM: runningFrom,
    STUB_LIBRARIES: libraries.join(" "),
    ...(os === "Darwin" && appDirectory && { MIRADOR_APP_DIR: appDirectory }),
    ...(display && { DISPLAY: ":0" }),
  };
  return { home, calls: () => readFileSync(calls, "utf8").trim().split("\n"), environment };
}

/** As people run it: piped into sh, which reads the script while it runs. Not spawnSync: the download server runs in this process. */
async function install(machine: ReturnType<typeof machineOf>) {
  requested.length = 0;
  const run = Bun.spawn(["/bin/sh", "-c", `/bin/cat "${INSTALL_SCRIPT}" | /bin/sh`], { env: machine.environment, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  return { exitCode, output, errors };
}

const callsTo = (calls: string[], program: string) => calls.filter((call) => call.startsWith(`${program} `));
const systemHasAnAgent = ["/opt/homebrew/bin", "/usr/local/bin"].some((directory) => ["claude", "opencode"].some((program) => existsSync(join(directory, program))));

test("on an Apple Silicon Mac it replaces the app in the folder with the latest release's, clears the quarantine and opens it", async () => {
  const machine = machineOf({ os: "Darwin" });
  const app = join(machine.home, "Applications", "Mirador.app");
  writeExecutable(join(app, "Contents", "MacOS", "left-from-the-old-version"), "exit 0");

  const result = await install(machine);

  expect(result.errors).not.toContain("Mirador was not installed");
  expect(result.exitCode).toBe(0);
  expect(requested).toEqual(["Mirador-macos-arm64.zip"]);
  expect(existsSync(join(app, "Contents", "MacOS", "launcher"))).toBe(true);
  expect(existsSync(join(app, "Contents", "MacOS", "left-from-the-old-version"))).toBe(false);
  expect(callsTo(machine.calls(), "xattr")).toEqual([`xattr -dr com.apple.quarantine ${app}`]);
  expect(callsTo(machine.calls(), "open")).toEqual([`open ${app}`]);
  expect(result.output).not.toContain("neither is installed");
});

test.skipIf(existsSync("/Applications/Mirador.app"))("on a Mac it updates the app where it already is, in ~/Applications", async () => {
  const machine = machineOf({ os: "Darwin", appDir: null });
  const app = join(machine.home, "Applications", "Mirador.app");
  writeExecutable(join(app, "Contents", "MacOS", "left-from-the-old-version"), "exit 0");
  expect((await install(machine)).exitCode).toBe(0);
  expect(existsSync(join(app, "Contents", "MacOS", "launcher"))).toBe(true);
  expect(callsTo(machine.calls(), "open")).toEqual([`open ${app}`]);
});

test("on a Mac it asks the user to quit a Mirador running from the folder it installs to, and checks only that folder", async () => {
  const machine = machineOf({ os: "Darwin", runningFrom: "Applications/Mirador.app/Contents/MacOS/" });
  const result = await install(machine);
  expect(result.exitCode).toBe(1);
  expect(result.errors).toContain("Mirador is running from");
  expect(requested).toEqual([]);
  expect(callsTo(machine.calls(), "pgrep")).toEqual([`pgrep -f -- ${join(machine.home, "Applications", "Mirador.app", "Contents", "MacOS")}/`]);
});

test("an Intel Mac is pointed to running Mirador from source, even from a shell under Rosetta", async () => {
  const result = await install(machineOf({ os: "Darwin", arch: "x86_64", appleSilicon: false }));
  expect(result.exitCode).toBe(1);
  expect(result.errors).toContain("the macOS app is for Apple Silicon");
  expect(requested).toEqual([]);
});

test("on Linux with the libraries in place it runs the installer for this architecture, which starts the app", async () => {
  const machine = machineOf({ os: "Linux", arch: "x86_64" });
  const result = await install(machine);

  expect(result.errors).not.toContain("Mirador was not installed");
  expect(result.exitCode).toBe(0);
  expect(requested).toEqual(["Mirador-linux-x64-Setup.tar.gz"]);
  expect(readFileSync(join(machine.home, "installed-arch"), "utf8")).toBe("x64");
  expect(callsTo(machine.calls(), "sudo")).toEqual([]);
  expect(result.output).toContain("Mirador is starting.");
});

test("on Linux it installs missing libraries with sudo apt-get, or dnf, before the app", async () => {
  const debian = machineOf({ os: "Linux", arch: "aarch64", libraries: ["libgtk-3.so.0"], packageManager: "apt-get" });
  expect((await install(debian)).exitCode).toBe(0);
  expect(requested).toEqual(["Mirador-linux-arm64-Setup.tar.gz"]);
  expect(callsTo(debian.calls(), "sudo")).toEqual([
    "sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q",
    "sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2",
  ]);

  const fedora = machineOf({ os: "Linux", arch: "x86_64", libraries: [], packageManager: "dnf" });
  expect((await install(fedora)).exitCode).toBe(0);
  expect(callsTo(fedora.calls(), "sudo")).toEqual(["sudo dnf install -y gtk3 webkit2gtk4.1 libayatana-appindicator-gtk3 librsvg2"]);
});

test("on Linux without apt-get or dnf it names the missing libraries and installs nothing", async () => {
  const result = await install(machineOf({ os: "Linux", arch: "x86_64", libraries: ["libgtk-3.so.0", "librsvg-2.so.2"] }));
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Missing: libwebkit2gtk-4.1.so.0 libayatana-appindicator3.so.1");
  expect(result.errors).toContain("install them with your package manager");
  expect(requested).toEqual([]);
});

test("on Linux without a display it leaves starting the app to the applications menu", async () => {
  const machine = machineOf({ os: "Linux", arch: "x86_64", display: false });
  const result = await install(machine);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Start Mirador from your applications menu.");
  expect(result.output).not.toContain("Mirador is starting.");
});

test("other systems and architectures are refused before downloading anything", async () => {
  const riscv = await install(machineOf({ os: "Linux", arch: "riscv64" }));
  expect(riscv.exitCode).toBe(1);
  expect(riscv.errors).toContain("built for x64 and arm64, not riscv64");
  const running = await install(machineOf({ os: "Linux", arch: "x86_64", runningFrom: "com.sodre90.mirador/stable/app/bin/" }));
  expect(running.exitCode).toBe(1);
  expect(running.errors).toContain("Mirador is running.");
  expect(requested).toEqual([]);
});

test("a failed download stops the install with the address it tried", async () => {
  assets.delete("Mirador-macos-arm64.zip");
  try {
    const result = await install(machineOf({ os: "Darwin" }));
    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain(`could not download http://127.0.0.1:${server.port}/Mirador-macos-arm64.zip`);
  } finally {
    assets.set("Mirador-macos-arm64.zip", macosApp());
  }
});

test.skipIf(systemHasAnAgent)("without Claude Code or opencode it says how to install Claude Code", async () => {
  const result = await install(machineOf({ os: "Linux", arch: "x86_64", agent: false }));
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("curl -fsSL https://claude.ai/install.sh | bash");
});
