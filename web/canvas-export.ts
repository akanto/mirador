import { canvasCaptureMessage, isCanvasFrameMessage } from "../shared/canvas-document.ts";
import { markdownRequest, pageFileName, type MarkdownDelivery } from "../shared/canvas-export.ts";
import type { CanvasItem } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { currentPageLibraries } from "./page-libraries.ts";

/** Save to project found a file at the path; saving again with `replace` writes over it. */
export class AlreadyThere extends Error {}

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
    (message, requestId) => {
      if (message.type === "canvas.saved-to-project" && message.requestId === requestId) return message.path;
      if (message.type === "canvas.export-failed" && message.requestId === requestId) {
        throw message.alreadyThere ? new AlreadyThere(message.message) : new Error(message.message);
      }
      return undefined;
    },
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

// The clipboard is written at once, with the content still on its way: a browser takes a write only while it handles the
// click, which would be over by the time the page is drawn or the host answers.
export const copyPageImage = (frame: HTMLIFrameElement) => navigator.clipboard.write([new ClipboardItem({ "image/png": capturedPage(frame) })]);

export const copyPageHtml = (itemId: string) =>
  navigator.clipboard.write([new ClipboardItem({ "text/plain": exportedPage(itemId).then((html) => new Blob([html], { type: "text/plain" })) })]);

/** Sends the request as the user's message to the conversation that showed the page. */
export function askAgentForMarkdown(page: CanvasItem, delivery: MarkdownDelivery, afterTurn: boolean) {
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
