import { describe, expect, test } from "bun:test";
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
