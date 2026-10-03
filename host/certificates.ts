import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { localNetworkName } from "./config.ts";

const AUTHORITY_DAYS = 3650;
/** Apple's platforms refuse longer-lived TLS server certificates, whoever issued them. */
const SERVER_CERTIFICATE_DAYS = 825;
const RENEWAL_DAYS_BEFORE_EXPIRY = 30;
const DAY_MILLISECONDS = 24 * 60 * 60_000;

export interface ServingCertificate {
  /** The server's certificate, followed by the authority that issued it when Mirador made it. */
  chain: string;
  key: string;
  /** Mirador's own certificate authority, which joined machines pin; null with the owner's certificate. */
  authority: string | null;
  /** Every host name and IP address the certificate is good for. */
  names: string[];
}

/** What invite links carry, so the joining machine knows the authority it should pin. */
export const authorityFingerprint = (authority: string) => createHash("sha256").update(new X509Certificate(authority).raw).digest("base64url");

/** Names and addresses other devices may reach this machine at; the server certificate covers them all. */
export function namesToCover(addressHost: string | null) {
  const networkAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((network) => network?.family === "IPv4" && !network.internal)
    .map((network) => network!.address);
  return [...new Set(["localhost", "127.0.0.1", hostname(), localNetworkName(), ...networkAddresses, ...(addressHost ? [addressHost] : [])])];
}

export function namesIn(certificate: string) {
  return (new X509Certificate(certificate).subjectAltName ?? "")
    .split(", ")
    .map((name) => name.replace(/^(DNS|IP Address):/, ""))
    .filter(Boolean);
}

const isIpAddress = (name: string) => /^\d+\.\d+\.\d+\.\d+$/.test(name);
const subjectAltName = (names: string[]) => names.map((name) => (isIpAddress(name) ? `IP:${name}` : `DNS:${name}`)).join(", ");

function openssl(directory: string, args: string[]) {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["openssl", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("Mirador needs openssl to make its certificate. Install it, or give the host a certificate of your own (tlsCertificate and tlsKey).");
  }
  if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${String(result.stderr ?? "").trim()}`);
}

function writePrivately(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Made here rather than by openssl: LibreSSL writes explicit curve parameters, which Bun's TLS cannot read. */
function writeNewKey(path: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writePrivately(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

/** Made once and kept: joined machines pin it, so server certificates it issues later keep working for them. */
function authorityIn(directory: string) {
  const authorityPath = join(directory, "authority.pem");
  if (existsSync(authorityPath)) return readFileSync(authorityPath, "utf8");
  writePrivately(
    join(directory, "authority.cnf"),
    [
      "[req]",
      "distinguished_name = subject",
      "prompt = no",
      "x509_extensions = authority",
      "[subject]",
      `CN = Mirador on ${hostname()} (certificate authority)`,
      "[authority]",
      "basicConstraints = critical, CA:TRUE, pathlen:0",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  writeNewKey(join(directory, "authority-key.pem"));
  openssl(directory, ["req", "-new", "-x509", "-config", "authority.cnf", "-key", "authority-key.pem", "-days", String(AUTHORITY_DAYS), "-out", "authority.pem"]);
  return readFileSync(authorityPath, "utf8");
}

function serverCertificateStillFits(certificate: string, authority: string, names: string[], now: number) {
  const parsed = new X509Certificate(certificate);
  const covered = new Set(namesIn(certificate));
  return (
    parsed.checkIssued(new X509Certificate(authority)) &&
    Date.parse(parsed.validTo) - now > RENEWAL_DAYS_BEFORE_EXPIRY * DAY_MILLISECONDS &&
    names.every((name) => covered.has(name))
  );
}

function issueServerCertificate(directory: string, names: string[]) {
  writePrivately(join(directory, "server.cnf"), ["[req]", "distinguished_name = subject", "prompt = no", "[subject]", `CN = Mirador on ${hostname()}`, ""].join("\n"));
  writePrivately(
    join(directory, "server.ext"),
    [
      "basicConstraints = CA:FALSE",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = serverAuth",
      "authorityKeyIdentifier = keyid",
      `subjectAltName = ${subjectAltName(names)}`,
      "",
    ].join("\n"),
  );
  writeNewKey(join(directory, "server-key.pem"));
  openssl(directory, ["req", "-new", "-config", "server.cnf", "-key", "server-key.pem", "-out", "server.csr"]);
  const serial = `0x${randomBytes(16).toString("hex")}`;
  openssl(directory, ["x509", "-req", "-in", "server.csr", "-CA", "authority.pem", "-CAkey", "authority-key.pem", "-set_serial", serial, "-days", String(SERVER_CERTIFICATE_DAYS), "-extfile", "server.ext", "-out", "server.pem"]);
}

/** Mirador's own: a server certificate from its own authority, issued again when it runs out or a name is missing. */
export function ownServingCertificate(dataDir: string, names: string[], now = Date.now()): ServingCertificate {
  const directory = join(dataDir, "tls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const authority = authorityIn(directory);
  const serverPath = join(directory, "server.pem");
  const fits = existsSync(serverPath) && serverCertificateStillFits(readFileSync(serverPath, "utf8"), authority, names, now);
  if (!fits) issueServerCertificate(directory, names);
  const server = readFileSync(serverPath, "utf8");
  return { chain: `${server.trimEnd()}\n${authority}`, key: readFileSync(join(directory, "server-key.pem"), "utf8"), authority, names: namesIn(server) };
}

export function servingCertificate(dataDir: string, names: string[], ownCertificate: { certificatePath: string; keyPath: string } | null): ServingCertificate {
  if (!ownCertificate) return ownServingCertificate(dataDir, names);
  const chain = readFileSync(ownCertificate.certificatePath, "utf8");
  return { chain, key: readFileSync(ownCertificate.keyPath, "utf8"), authority: null, names: namesIn(chain) };
}
