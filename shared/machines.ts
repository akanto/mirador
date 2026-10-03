const joinPath = /^#\/join\/([\w-]+)$/;

/** The invite code in an invite link's #part, e.g. #/join/ABCD-EFGH-JKLM. */
export const joinCodeIn = (hash: string) => joinPath.exec(hash)?.[1] ?? null;

export const inviteLink = (origin: string, code: string) => `${origin}/#/join/${code}`;

/** What someone types or pastes for a machine: its name on the network, its address, or an invite link from it. */
export function machineAddress(text: string): { origin: string; joinCode: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { origin: url.origin, joinCode: joinCodeIn(url.hash) };
  } catch {
    return null;
  }
}
