import { afterEach, beforeEach, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFingerprint, namesIn, ownServingCertificate, type ServingCertificate } from "../host/certificates.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mirador-certificates-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const DAY = 24 * 60 * 60_000;

async function answersPinnedTo(certificate: ServingCertificate, authority: string, host: string) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: certificate.chain, key: certificate.key }, fetch: () => new Response("hello") });
  try {
    const response = await fetch(`https://${host}:${server.port}`, { tls: { ca: authority } });
    return await response.text();
  } finally {
    server.stop(true);
  }
}

test("Mirador's own authority issues a server certificate for every name, which a client pinned to the authority accepts", async () => {
  const certificate = ownServingCertificate(dataDir, ["localhost", "127.0.0.1", "box.local"]);
  expect(certificate.names).toEqual(["localhost", "127.0.0.1", "box.local"]);
  expect(new X509Certificate(certificate.authority!).ca).toBe(true);
  expect(await answersPinnedTo(certificate, certificate.authority!, "localhost")).toBe("hello");
  expect(await answersPinnedTo(certificate, certificate.authority!, "127.0.0.1")).toBe("hello");
  expect(authorityFingerprint(certificate.authority!)).toMatch(/^[\w-]{43}$/);
  ["authority-key.pem", "server-key.pem"].forEach((key) => expect(statSync(join(dataDir, "tls", key)).mode & 0o777).toBe(0o600));
});

test("the server certificate is kept while it fits, and issued again by the same authority for a new name or near its expiry", async () => {
  const first = ownServingCertificate(dataDir, ["localhost"]);
  expect(ownServingCertificate(dataDir, ["localhost"]).chain).toBe(first.chain);

  const withNewName = ownServingCertificate(dataDir, ["localhost", "10.1.2.3"]);
  expect(withNewName.chain).not.toBe(first.chain);
  expect(withNewName.authority).toBe(first.authority);
  expect(namesIn(withNewName.chain)).toEqual(["localhost", "10.1.2.3"]);
  expect(await answersPinnedTo(withNewName, first.authority!, "localhost")).toBe("hello");

  const expiresAt = Date.parse(new X509Certificate(withNewName.chain).validTo);
  const renewed = ownServingCertificate(dataDir, ["localhost"], expiresAt - 10 * DAY);
  expect(renewed.chain).not.toBe(withNewName.chain);
  expect(renewed.authority).toBe(first.authority);
});

test("a client pinned to another authority refuses the server", async () => {
  const certificate = ownServingCertificate(dataDir, ["localhost"]);
  const otherDataDir = mkdtempSync(join(tmpdir(), "mirador-certificates-other-"));
  try {
    const otherAuthority = ownServingCertificate(otherDataDir, ["localhost"]).authority!;
    expect(answersPinnedTo(certificate, otherAuthority, "localhost")).rejects.toThrow();
  } finally {
    rmSync(otherDataDir, { recursive: true, force: true });
  }
});

test("the server certificate lasts at most 825 days, as Apple's platforms require", () => {
  const { chain } = ownServingCertificate(dataDir, ["localhost"]);
  const server = new X509Certificate(chain);
  expect(Date.parse(server.validTo) - Date.parse(server.validFrom)).toBeLessThanOrEqual(825 * DAY);
  expect(readFileSync(join(dataDir, "tls", "authority.pem"), "utf8")).toBe(chain.slice(chain.indexOf("-----BEGIN", 1)));
});
