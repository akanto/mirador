import { describe, expect, test } from "bun:test";
import { forwardedHeaders, relayedHeaders } from "../host/machine-relays.ts";

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
