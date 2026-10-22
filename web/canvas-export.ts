import { canvasCaptureMessage, isCanvasFrameMessage } from "../shared/canvas-document.ts";
import { markdownRequest, pageFileName, type MarkdownDelivery } from "../shared/canvas-export.ts";
import type { ShowItem } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { connection } from "./connection.ts";
import { currentPageLibraries } from "./page-libraries.ts";

/** Save to project found a file at the path; saving again with `replace` writes over it. */
export class AlreadyThere extends Error {}

const savedPath = (message: ServerMessage, requestId: string) => {
  if (message.type === "canvas.saved-to-project" && message.requestId === requestId) return message.path;
  if (message.type === "canvas.export-failed" && message.requestId === requestId) {
    throw message.alreadyThere ? new AlreadyThere(message.message) : new Error(message.message);
  }
  return undefined;
};

const exportedPage = (itemId: string) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "canvas.export", requestId, itemId, libraries: currentPageLibraries() }),
    (message, requestId) => {
      if (message.type === "canvas.exported" && message.requestId === requestId) return message.html;
      if (message.type === "canvas.export-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );

/** Writes the page into the conversation's project; resolves to the path it was saved at, relative to the project. */
export const savePageToProject = (itemId: string, path: string, replace: boolean) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "canvas.save-to-project", requestId, itemId, path, libraries: currentPageLibraries(), replace }),
    savedPath,
  );

const CAPTURE_TIMEOUT_MS = 30_000;

/** The page drawn as a PNG by its own frame, as only the frame can see its content. */
function capturedPage(frame: HTMLIFrameElement): Promise<Blob> {
  const page = frame.contentWindow;
  if (!page) return Promise.reject(new Error("The page is not shown."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const stopWaiting = () => {
      window.removeEventListener("message", listener);
      clearTimeout(timer);
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== page || !isCanvasFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "captured" && message.requestId === requestId) {
        stopWaiting();
        resolve(message.image);
      }
      if (message.kind === "capture-failed" && message.requestId === requestId) {
        stopWaiting();
        reject(new Error(`The page could not be drawn as an image: ${message.message}`));
      }
    };
    const timer = setTimeout(() => {
      stopWaiting();
      reject(new Error("The page took too long to draw as an image."));
    }, CAPTURE_TIMEOUT_MS);
    window.addEventListener("message", listener);
    page.postMessage(canvasCaptureMessage(requestId), "*");
  });
}

const asBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  return btoa(chunks.join(""));
};

// The host ends the connection on a message over 16 MB, and base64 grows a PNG by a third: past this a save would
// drop the connection and read as a lost host, so the image is refused while the reason is still the image.
const MAX_SENT_IMAGE_BYTES = 12 * 1024 * 1024;

export const refuseOversizedImage = (image: Blob) => {
  if (image.size > MAX_SENT_IMAGE_BYTES) throw new Error("The page's image is too large to send to the host.");
  return image;
};

/** Draws the page as a PNG and writes it into the conversation's project; resolves to the path it was saved at. */
export const savePageImageToProject = (itemId: string, frame: HTMLIFrameElement, path: string, replace: boolean) =>
  capturedPage(frame)
    .then(refuseOversizedImage)
    .then(asBase64)
    .then((image) =>
      connection.sendAndAwait((requestId) => ({ type: "canvas.save-image-to-project", requestId, itemId, path, image, replace }), savedPath),
    );

// The clipboard is written at once, with the content still on its way: a browser takes a write only while it handles the
// click, which would be over by the time the page is drawn or the host answers.
// Where the page could not be drawn, WebKit refuses the write with its own NotAllowedError and hides the reason, so the capture's error wins when both fail.
export const writeImageToClipboard = (capture: Promise<Blob>, clipboard: Pick<Clipboard, "write">) => {
  const captureFailure = capture.then(() => null, (error: unknown) => error);
  return clipboard.write([new ClipboardItem({ "image/png": capture })]).catch(async (error: unknown) => {
    throw (await captureFailure) ?? error;
  });
};

export const copyPageImage = (frame: HTMLIFrameElement) => writeImageToClipboard(capturedPage(frame), navigator.clipboard);

export const copyPageHtml = (itemId: string) =>
  navigator.clipboard.write([new ClipboardItem({ "text/plain": exportedPage(itemId).then((html) => new Blob([html], { type: "text/plain" })) })]);

/** Sends the request as the user's message to the conversation that showed the page. */
export function askAgentForMarkdown(page: ShowItem, delivery: MarkdownDelivery, afterTurn: boolean) {
  const text = markdownRequest({ title: page.title, html: page.html ?? "" }, delivery);
  if (!connection.send({ type: "conversation.prompt", conversationId: page.conversationId, text, imageIds: [], afterTurn })) throw new Error("Not connected to the host.");
}

const DOWNLOAD_LINK_LIFETIME_MS = 60_000;

export async function downloadPage(page: { id: string; title: string }) {
  const html = await exportedPage(page.id);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  link.download = pageFileName(page.title);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), DOWNLOAD_LINK_LIFETIME_MS);
}
