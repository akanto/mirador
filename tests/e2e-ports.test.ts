import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const e2eDir = join(import.meta.dir, "..", "e2e");

/**
 * Below are the owner's own Mirador (4600, its canvas and network ports, machine relays 4620–4719); above are Android
 * emulators' console and adb ports (5554 up) and mirador-mobile's e2e hosts (5800 up), so the suites can run at once.
 */
const MIRADOR_E2E_PORTS = { lowest: 4720, highest: 5499 };

interface HostPort {
  file: string;
  port: number;
  /** Started with MIRADOR_NETWORK, so it also serves on port+2 and port+3. */
  servesTheNetwork: boolean;
}

const e2eSources = () =>
  readdirSync(e2eDir)
    .filter((name) => name.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(e2eDir, file), "utf8") }));

/** The ports given to `new TestHost(…)`, or to a spec's `useHost(…)`, which passes its port on to TestHost, each with the rest of its statement. */
const hostPorts = (): HostPort[] =>
  e2eSources().flatMap(({ file, text }) =>
    [...text.matchAll(/(?:new TestHost|useHost)[(]\s*(\d+)(?=([^;]*))/g)].map(([, port, statement]) => ({
      file,
      port: Number(port),
      servesTheNetwork: statement!.includes("MIRADOR_NETWORK"),
    })),
  );

const portsOf = ({ port, servesTheNetwork }: HostPort) => (servesTheNetwork ? [port, port + 1, port + 2, port + 3] : [port, port + 1]);

test("every e2e host's ports belong to that host alone: its port, the canvas port after it, and the two after those when it serves the network", () => {
  const takenPorts = hostPorts().flatMap((host) => portsOf(host).map((taken) => ({ taken, host: `${host.file} (${host.port})` })));
  const shared = [...Map.groupBy(takenPorts, ({ taken }) => taken)]
    .filter(([, hosts]) => hosts.length > 1)
    .map(([taken, hosts]) => `${taken}: ${hosts.map(({ host }) => host).join(", ")}`);
  expect(shared).toEqual([]);
});

test("every e2e host stays in Mirador's own port range", () => {
  const outside = hostPorts().filter((host) => host.port < MIRADOR_E2E_PORTS.lowest || Math.max(...portsOf(host)) > MIRADOR_E2E_PORTS.highest);
  expect(outside).toEqual([]);
});

test("the scan sees every e2e host: each gets its port as a number, or through a useHost(port) helper", () => {
  const unseen = e2eSources().flatMap(({ file, text }) =>
    [...text.matchAll(/new TestHost[(]\s*([^\s,)]+)/g)]
      .map(([, argument]) => argument)
      .filter((argument) => !/^\d+$/.test(argument) && !(argument === "port" && text.includes("function useHost(port: number)")))
      .map((argument) => `${file}: new TestHost(${argument}`),
  );
  expect(unseen).toEqual([]);
  expect(hostPorts().length).toBeGreaterThan(50);
  expect(hostPorts().filter(({ servesTheNetwork }) => servesTheNetwork).length).toBeGreaterThan(0);
});
