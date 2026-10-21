import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** How a downloaded file proves it is the one asked for: Hugging Face gives LFS files' SHA-256 and other files' git blob SHA-1. */
export type Checksum = { sha256: string } | { gitBlobSha1: string };

export interface Download {
  url: string;
  destination: string;
  size: number;
  checksum: Checksum;
}

const ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000];

const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? null;

/** Whether a download already finished: only verified files get their final name. */
export const isDownloaded = async ({ destination, size }: Download) => (await sizeOf(destination)) === size;

/** How much of a download is on disk already, finished or kept from an interrupted one. */
export async function bytesOnDisk(download: Download) {
  if (await isDownloaded(download)) return download.size;
  return Math.min((await sizeOf(partOf(download))) ?? 0, download.size);
}

const partOf = ({ destination }: Download) => `${destination}.part`;

async function checksumOf(path: string, checksum: Checksum, size: number) {
  const hash = createHash("sha256" in checksum ? "sha256" : "sha1");
  if ("gitBlobSha1" in checksum) hash.update(`blob ${size}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const expectedChecksum = (checksum: Checksum) => ("sha256" in checksum ? checksum.sha256 : checksum.gitBlobSha1);

/** A server's failure worth asking again: it may answer the next time. */
class Transient extends Error {}

async function fetchRest(download: Download, from: number, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(download.url, { headers: from > 0 ? { Range: `bytes=${from}-` } : {}, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Transient(`Couldn't reach ${new URL(download.url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 500 || response.status === 429) throw new Transient(`${new URL(download.url).host} answered ${response.status}.`);
  if (!response.ok) throw new Error(`${new URL(download.url).host} answered ${response.status} for ${download.url}.`);
  return response;
}

async function downloadOnce(download: Download, signal: AbortSignal, onProgress: (bytesOnDisk: number) => void) {
  const part = partOf(download);
  await mkdir(dirname(part), { recursive: true });
  let from = await bytesOnDisk(download);
  if (from < download.size) {
    const response = await fetchRest(download, from, signal);
    if (response.status !== 206) from = 0;
    onProgress(from);
    const file = await open(part, from > 0 ? "a" : "w");
    try {
      for await (const chunk of response.body!) {
        await file.write(chunk);
        from += chunk.byteLength;
        onProgress(from);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Transient(`The download of ${download.url} broke off.`);
    } finally {
      await file.close();
    }
  }
  if ((await sizeOf(part)) !== download.size) {
    await rm(part, { force: true });
    onProgress(0);
    throw new Transient(`${download.url} came in at a size other than ${download.size} bytes.`);
  }
  if ((await checksumOf(part, download.checksum, download.size)) !== expectedChecksum(download.checksum)) {
    await rm(part, { force: true });
    onProgress(0);
    throw new Error(`${download.url} came in different from what was expected, so Mirador threw it away. Setting up again downloads it again.`);
  }
  await rename(part, download.destination);
}

/** Downloads where an interrupted download left off, asking again after a server's passing failure, and keeps a file only once it checks out. */
export async function downloadFile(download: Download, signal: AbortSignal, onProgress: (bytesOnDisk: number) => void, attempt = 1): Promise<void> {
  if (await isDownloaded(download)) return;
  try {
    await downloadOnce(download, signal, onProgress);
  } catch (error) {
    if (!(error instanceof Transient) || attempt === ATTEMPTS) throw error;
    await Bun.sleep(RETRY_DELAYS_MS[attempt - 1]!);
    await downloadFile(download, signal, onProgress, attempt + 1);
  }
}
