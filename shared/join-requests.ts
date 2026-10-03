/** Long enough that something posing as the machine matches the number by chance once in a million tries. */
const NUMBER_DIGITS = 6;

const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const newNonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Sent before the nonce itself, so the device asking is bound to its nonce before it learns the machine's. */
export const commitmentTo = async (nonce: string) => base64url(await sha256(nonce));

/**
 * The number the device asking to join shows, and the approver types on the machine. Each side works it out from the
 * certificate authority it checked the other's certificate against, so a machine in between gets a different number;
 * as each side's nonce is fixed before the other's is known, it cannot try nonces until the numbers agree.
 */
export async function matchingNumber(authorityFingerprint: string | null, requesterNonce: string, machineNonce: string) {
  const digest = await sha256(["mirador-join", authorityFingerprint ?? "", requesterNonce, machineNonce].join("\n"));
  const number = new DataView(digest.buffer).getUint32(0) % 10 ** NUMBER_DIGITS;
  return String(number).padStart(NUMBER_DIGITS, "0");
}

/** E.g. 123 456, easier to read out and compare than 123456. */
export const spacedNumber = (number: string) => `${number.slice(0, 3)} ${number.slice(3)}`;

export const typedNumber = (text: string) => text.replace(/\D/g, "");

export interface JoinRequestOpened {
  id: string;
  secret: string;
  machineNonce: string;
  /** Milliseconds until the request expires, as the clocks of the two machines may disagree. */
  expiresIn: number;
}

export type JoinRequestAnswer = { answer: "waiting" } | { answer: "denied" } | { answer: "approved"; deviceId: string; token: string };
