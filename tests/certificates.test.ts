import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFingerprint, namesIn, opensslConfigValue, ownServingCertificate, type ServingCertificate } from "../host/certificates.ts";

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

test("a renewal whose re-signing fails leaves the key on disk matching the certificate on disk", async () => {
  const first = ownServingCertificate(dataDir, ["localhost"]);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(join(dataDir, "tls", "authority-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }).toString());

  expect(() => ownServingCertificate(dataDir, ["localhost", "10.9.8.7"])).toThrow(/openssl x509 failed/);

  expect(readFileSync(join(dataDir, "tls", "server-key.pem"), "utf8")).toBe(first.key);
  const onDisk = {
    chain: `${readFileSync(join(dataDir, "tls", "server.pem"), "utf8").trimEnd()}\n${first.authority}`,
    key: readFileSync(join(dataDir, "tls", "server-key.pem"), "utf8"),
    authority: first.authority!,
    names: [],
  };
  expect(await answersPinnedTo(onDisk, first.authority!, "localhost")).toBe("hello");
});

test("the server certificate lasts at most 825 days, as Apple's platforms require", () => {
  const { chain } = ownServingCertificate(dataDir, ["localhost"]);
  const server = new X509Certificate(chain);
  expect(Date.parse(server.validTo) - Date.parse(server.validFrom)).toBeLessThanOrEqual(825 * DAY);
  expect(readFileSync(join(dataDir, "tls", "authority.pem"), "utf8")).toBe(chain.slice(chain.indexOf("-----BEGIN", 1)));
});

test("host names go into the openssl config quoted, so its variable expansion cannot mangle them", () => {
  ownServingCertificate(dataDir, ["localhost"]);
  for (const config of ["server.cnf", "authority.cnf"]) {
    expect(readFileSync(join(dataDir, "tls", config), "utf8")).toMatch(/^CN = "Mirador on .*"$/m);
  }

  const hostile = 'box$1 "odd" \\ end';
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(join(dataDir, "t.key"), privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  writeFileSync(join(dataDir, "t.cnf"), ["[req]", "distinguished_name = subject", "prompt = no", "[subject]", `CN = ${opensslConfigValue(`Mirador on ${hostile}`)}`, ""].join("\n"));
  const request = Bun.spawnSync(["openssl", "req", "-new", "-config", "t.cnf", "-key", "t.key", "-out", "t.csr"], { cwd: dataDir, stdout: "pipe", stderr: "pipe" });
  expect(request.exitCode).toBe(0);
  const der = Buffer.from(readFileSync(join(dataDir, "t.csr"), "utf8").split("\n").filter((line) => !line.startsWith("-")).join(""), "base64");
  expect(der.includes(Buffer.from(`Mirador on ${hostile}`))).toBe(true);
});
