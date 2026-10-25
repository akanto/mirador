import { useEffect, useMemo, useRef } from "react";
import { pluginItemOf } from "../shared/canvas-plugins.ts";
import { pluginItemMessage, pluginItemPage, pluginItemReplyFailedMessage, pluginItemReplyMessage, type CanvasFrameMessage } from "../shared/canvas-document.ts";
import type { PluginCanvasItem } from "../shared/model.ts";
import { CanvasFrame } from "./Canvas.tsx";
import { connection } from "./connection.ts";

/** Hands the user's action to the item's plugin on the host and waits for its reply. */
async function replyTo(itemId: string, action: unknown): Promise<unknown> {
  const { reply, problem } = await connection.sendAndAwait(
    (requestId) => ({ type: "canvas.item-action", requestId, itemId, action }),
    (message, requestId) => (message.type === "canvas.item-acted" && message.requestId === requestId ? message : undefined),
  );
  if (problem !== null) throw new Error(problem);
  return reply;
}

/** What a plugin published, when its plugin isn't installed to draw it: never a blank page. */
function WithoutItsPlugin({ item }: { item: PluginCanvasItem }) {
  return (
    <div className="plugin-item-missing">
      <p>The {item.plugin} plugin isn't installed, so this is what it published, as it is.</p>
      <pre>{JSON.stringify(item.data, null, 2)}</pre>
    </div>
  );
}

/** A plugin's item, drawn by the plugin's canvas view: its page loads once and every change to the item reaches it as a message. */
export function PluginItemView({ item, viewPath, assetsOrigin, fitsContent = false }: { item: PluginCanvasItem; viewPath: string | undefined; assetsOrigin: string; fitsContent?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(item);
  latest.current = item;
  const viewUrl = viewPath && `${assetsOrigin}${viewPath}`;
  const page = useMemo(() => viewUrl && pluginItemPage(viewUrl, item.id), [viewUrl, item.id]);
  const postItem = () => frame.current?.contentWindow?.postMessage(pluginItemMessage(pluginItemOf(latest.current)), "*");

  useEffect(postItem, [item]);

  const answer = async (requestId: string, action: unknown) => {
    const answerTo = frame.current?.contentWindow;
    try {
      answerTo?.postMessage(pluginItemReplyMessage(requestId, await replyTo(item.id, action)), "*");
    } catch (error) {
      answerTo?.postMessage(pluginItemReplyFailedMessage(requestId, error instanceof Error ? error.message : String(error)), "*");
    }
  };

  const received = (message: CanvasFrameMessage) => {
    if (message.kind === "item-ready") postItem();
    if (message.kind === "item-send" && typeof message.requestId === "string") void answer(message.requestId, message.action);
  };

  if (!page) return <WithoutItsPlugin item={item} />;
  return <CanvasFrame frameId={item.id} html={page} assetsOrigin={assetsOrigin} className="plugin" fitsContent={fitsContent} frameRef={frame} onMessage={received} />;
}
