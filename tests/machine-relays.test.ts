import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFingerprint, ownServingCertificate } from "../host/certificates.ts";
import { forwardedHeaders, MachineRelays, relayedHeaders } from "../host/machine-relays.ts";
import { Store } from "../host/store.ts";

const machine = "https://home-server.example.ts.net";

describe("forwardedHeaders", () => {
  test("signs in with the device token instead of this host's cookie, and says the page is the machine's own", () => {
    const incoming = new Headers({
      host: "127.0.0.1:4620",
      cookie: "mirador_token=this-hosts-own",
      origin: "http://127.0.0.1:4620",
      referer: "http://127.0.0.1:4620/",
      "sec-websocket-key": "abc",
      accept: "application/json",
    });
    expect(Object.fromEntries(forwardedHeaders(incoming, machine, "device-token"))).toEqual({
      accept: "application/json",
      cookie: "mirador_token=device-token",
      origin: machine,
    });
  });

  test("adds no origin where the page sent none, and no cookie before this host has joined", () => {
    expect(Object.fromEntries(forwardedHeaders(new Headers({ cookie: "mirador_token=x", accept: "*/*" }), machine, null))).toEqual({ accept: "*/*" });
  });
});

describe("relayedHeaders", () => {
  test("keeps the machine's cookies off this host's address, and its redirects on the relay", () => {
    const upstream = new Headers({ "set-cookie": "mirador_token=machine; Path=/", "content-encoding": "gzip", location: `${machine}/#/c/1`, "content-type": "text/html" });
    expect(Object.fromEntries(relayedHeaders(upstream, machine, "http://127.0.0.1:4620"))).toEqual({
      "content-type": "text/html",
      location: "http://127.0.0.1:4620/#/c/1",
    });
  });
});

describe("relay ports", () => {
  const freePorts = (count: number) =>
    Array.from({ length: count }, () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })).map((server) => {
      const { port } = server;
      server.stop(true);
      return port!;
    });

  test("keep a machine on its port from before, and move it into the range the desktop app lets its window load", () => {
    const [kept, inRange, outside] = freePorts(3) as [number, number, number];
    const store = new Store(":memory:");
    store.insertMachine({ id: "kept", name: "Kept", origin: "https://kept.example", createdAt: 1 });
    store.insertMachine({ id: "moved", name: "Moved", origin: "https://moved.example", createdAt: 2 });
    store.setMachineRelayPort("kept", kept);
    store.setMachineRelayPort("moved", outside);
    const relays = new MachineRelays(store, [inRange, kept], () => true, () => {});
    relays.startAll();
    try {
      expect(store.listMachines().map(({ id, relayPort }) => [id, relayPort])).toEqual([
        ["kept", kept],
        ["moved", inRange],
      ]);
    } finally {
      relays.stopAll();
    }
  });
});

describe("joining a machine that made its own certificate", () => {
  const cleanUps: (() => void)[] = [];
  afterEach(() => cleanUps.splice(0).forEach((cleanUp) => cleanUp()));

  function ownAuthority() {
    const dataDir = mkdtempSync(join(tmpdir(), "mirador-machine-"));
    cleanUps.push(() => rmSync(dataDir, { recursive: true, force: true }));
    return ownServingCertificate(dataDir, ["127.0.0.1"]);
  }

  /** A machine's Mirador on the network, which lets in every code it is sent. */
  function machineOnTheNetwork(certificate = ownAuthority(), offeredAuthority = certificate.authority) {
    const codesReceived: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: certificate.chain, key: certificate.key },
      routes: {
        "/mirador-ca.pem": new Response(offeredAuthority),
        "/join": {
          POST: async (request) => {
            codesReceived.push(((await request.json()) as { code: string }).code);
            return Response.json({ token: "device-token" });
          },
        },
      },
      fetch: () => new Response("join page"),
    });
    cleanUps.push(() => server.stop(true));
    const store = new Store(":memory:");
    store.insertMachine({ id: "box", name: "Box", origin: `https://127.0.0.1:${server.port}`, createdAt: 1 });
    const relays = new MachineRelays(store, [], () => true, () => {});
    return { authority: offeredAuthority!, codesReceived, store, join: relays.join.bind(relays, "box") };
  }

  test("trusts the certificate authority the invite link names, and sends no code to a machine with another one", async () => {
    const machine = machineOnTheNetwork();
    await expect(machine.join("WRONG-LINK", authorityFingerprint(ownAuthority().authority!))).rejects.toThrow(
      "Box's certificate authority is not the one in the invite link, so the code was not sent.",
    );
    expect(machine.codesReceived).toEqual([]);

    await machine.join("FROM-LINK", authorityFingerprint(machine.authority));
    expect(machine.codesReceived).toEqual(["FROM-LINK"]);
    expect(machine.store.machineAuthority("box")).toBe(machine.authority);
    expect(machine.store.machineDeviceToken("box")).toBe("device-token");
  });

  test("with a bare code, trusts the authority it first joined by, and an invite link's alone once it changed", async () => {
    const machine = machineOnTheNetwork();
    await machine.join("FIRST");
    expect(machine.store.machineAuthority("box")).toBe(machine.authority);

    machine.store.setMachineAuthority("box", ownAuthority().authority);
    await expect(machine.join("AFTER-CHANGE")).rejects.toThrow("Box's certificate authority changed since this computer joined it, so the code was not sent.");
    await machine.join("FROM-LINK", authorityFingerprint(machine.authority));
    expect(machine.codesReceived).toEqual(["FIRST", "FROM-LINK"]);
    expect(machine.store.machineAuthority("box")).toBe(machine.authority);
  });

  test("sends no code to a machine whose certificate is not from the authority it offers", async () => {
    const machine = machineOnTheNetwork(ownAuthority(), ownAuthority().authority);
    await expect(machine.join("CODE", authorityFingerprint(machine.authority))).rejects.toThrow(
      "Box's certificate is not from its own certificate authority, or does not name 127.0.0.1.",
    );
    expect(machine.codesReceived).toEqual([]);
    expect(machine.store.machineAuthority("box")).toBeNull();
  });
});
