import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { inflateRawSync } from "node:zlib";
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { Hub, socketData, webSocketCompression, type BrowserSocket } from "../host/hub.ts";
import { imagesOf, lowDataEvent, wholeToolOutput } from "../host/low-data.ts";
import { eventImagePath, shortenedOutputOf } from "../shared/low-data.ts";
import type { StoredEvent } from "../shared/model.ts";
import { buildTimeline, type ToolBlock } from "../shared/timeline.ts";
import { shellCommandOf } from "../web/shell.ts";

const stored = (seq: number, update: SessionUpdate): StoredEvent => ({ seq, at: seq * 1000, event: { type: "acp", update } });
const screenshot = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
const text = (value: string): ToolCallContent => ({ type: "content", content: { type: "text", text: value } });
const numberedLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
const updateOf = ({ event }: StoredEvent) => (event.type === "acp" ? event.update : null) as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;

describe("lowDataEvent", () => {
  const read = stored(7, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [{ type: "content", content: screenshot }],
    rawOutput: [{ type: "image", source: { type: "base64", data: screenshot.data, media_type: "image/png" } }],
    _meta: { claudeCode: { toolName: "Read", toolResponse: { type: "image", file: { base64: screenshot.data } } } },
  });

  test("a screenshot a tool returned becomes a link to it on the host, and the copies of it go", () => {
    const lowData = updateOf(lowDataEvent("c1", read));
    expect(lowData.content).toEqual([{ type: "content", content: { type: "image", mimeType: "image/png", data: "", uri: "/conversations/c1/events/7/images/0" } }]);
    expect(lowData.rawOutput).toBeUndefined();
    expect(lowData._meta).toEqual({ claudeCode: { toolName: "Read" } });
    expect(JSON.stringify(lowData)).not.toContain(screenshot.data);
  });

  test("the link numbers the event's images as the host finds them to serve", () => {
    const twoImages = stored(3, { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [text("two shots"), { type: "content", content: screenshot }, { type: "content", content: { ...screenshot, data: "R0lGOD==" } }] });
    const links = updateOf(lowDataEvent("c1", twoImages)).content!.flatMap((item) => (item.type === "content" && item.content.type === "image" ? [item.content.uri] : []));
    expect(links).toEqual([eventImagePath("c1", 3, 0), eventImagePath("c1", 3, 1)]);
    expect(imagesOf(twoImages).map(({ data }) => data)).toEqual([screenshot.data, "R0lGOD=="]);
  });

  test("long tool output keeps its first lines, marked with the event that holds all of it, and short output stays whole", () => {
    const bash = stored(12, { sessionUpdate: "tool_call_update", toolCallId: "t2", content: [text("List files"), text("```console\n" + numberedLines(500) + "\n```")] });
    const content = updateOf(lowDataEvent("c1", bash)).content!;
    expect(content[0]).toEqual(text("List files"));
    expect(shortenedOutputOf(content)).toEqual({ seq: 12 });
    expect(JSON.stringify(content).length).toBeLessThan(2_500);
    expect(shortenedOutputOf(updateOf(lowDataEvent("c1", stored(13, { sessionUpdate: "tool_call_update", toolCallId: "t3", content: [text(numberedLines(5))] }))).content!)).toBeNull();
  });

  test("a shortened command's output still reads as its first lines, without the fence around them", () => {
    const events = [
      stored(1, { sessionUpdate: "tool_call", toolCallId: "t2", title: "ls", kind: "execute", rawInput: { command: "ls", description: "List files" }, _meta: { claudeCode: { toolName: "Bash" } } }),
      stored(2, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [text("List files"), text("```console\n" + numberedLines(500) + "\n```")] }),
    ];
    const block = buildTimeline(events.map((event) => lowDataEvent("c1", event)))[0] as ToolBlock;
    expect(shellCommandOf(block).output).toBe(numberedLines(19));
  });

  test("the timeline still knows a subagent's tool, its parent and that it went to the background, and opencode's exit code stays", () => {
    const agent = stored(4, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t4",
      status: "completed",
      _meta: { claudeCode: { toolName: "Agent", parentToolUseId: "t0", toolResponse: { isAsync: true, agentId: "a1", prompt: "a long brief" } } },
    });
    expect(updateOf(lowDataEvent("c1", agent))._meta).toEqual({ claudeCode: { toolName: "Agent", parentToolUseId: "t0", toolResponse: { isAsync: true } } });
    const opencode = stored(5, { sessionUpdate: "tool_call_update", toolCallId: "t5", rawOutput: { output: numberedLines(500), metadata: { exit: 2, output: "…" } } });
    expect(updateOf(lowDataEvent("c1", opencode)).rawOutput).toEqual({ metadata: { exit: 2 } });
  });

  test("the whole output of a shortened event comes back in full, with its images still links", () => {
    const long = "```console\n" + numberedLines(500) + "\n```";
    const event = stored(9, { sessionUpdate: "tool_call_update", toolCallId: "t6", content: [text(long), { type: "content", content: screenshot }] });
    expect(wholeToolOutput("c1", event)).toEqual([text(long), { type: "content", content: { type: "image", mimeType: "image/png", data: "", uri: "/conversations/c1/events/9/images/0" } }]);
  });

  test("events other than the agent's updates are left as they are", () => {
    const message: StoredEvent = { seq: 1, at: 1, event: { type: "user-message", text: "hi", imageIds: ["x.png"] } };
    expect(lowDataEvent("c1", message)).toBe(message);
  });
});

describe("Hub.publishEvent", () => {
  function connect(hub: Hub, deviceId: string | null, subscription: "whole" | "low data") {
    const sent: { payload: string; compressed: boolean }[] = [];
    const socket = { data: socketData("page", deviceId), send: (payload: string, compressed: boolean) => sent.push({ payload, compressed }) } as unknown as BrowserSocket;
    socket.data.subscriptions.add("c1");
    if (subscription === "low data") socket.data.lowDataSubscriptions.add("c1");
    hub.add(socket);
    return sent;
  }

  test("a phone following in low data gets the event's low-data form, compressed; this machine's page gets it whole, uncompressed", () => {
    const hub = new Hub();
    const page = connect(hub, null, "whole");
    const phone = connect(hub, "phone", "low data");
    const event = stored(2, { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "content", content: screenshot }] });
    hub.publishEvent("c1", event);
    expect(page.map(({ compressed }) => compressed)).toEqual([false]);
    expect(JSON.parse(page[0]!.payload).event).toEqual(event);
    expect(phone.map(({ compressed }) => compressed)).toEqual([true]);
    expect(JSON.parse(phone[0]!.payload).event).toEqual(lowDataEvent("c1", event));
  });
});

describe("webSocketCompression", () => {
  async function firstFrameSent(message: string) {
    const server = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response(null, { status: 400 })),
      websocket: { perMessageDeflate: webSocketCompression, open: (socket) => void socket.send(message, true), message() {} },
    });
    try {
      const received = await new Promise<Buffer>((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const client = connect(server.port!, "127.0.0.1", () =>
          client.write(
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
          ),
        );
        client.on("error", reject);
        client.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          const frameStart = bytes.indexOf("\r\n\r\n") + 4;
          if (frameStart >= 4 && bytes.length > frameStart + 2 && bytes.length >= frameStart + 2 + (bytes[frameStart + 1]! & 0x7f)) {
            client.destroy();
            resolve(bytes.subarray(frameStart));
          }
        });
      });
      return { compressed: (received[0]! & 0x40) !== 0, payload: received.subarray(2, 2 + (received[1]! & 0x7f)) };
    } finally {
      server.stop(true);
    }
  }

  test("a compressed message leaves its deflate stream open, as Android's OkHttp needs to read it", async () => {
    const message = JSON.stringify({ type: "small" });
    const { compressed, payload } = await firstFrameSent(message);
    expect(compressed).toBe(true);
    const finalBlock = (payload[0]! & 1) === 1;
    expect(finalBlock).toBe(false);
    expect(inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]), { finishFlush: 2 }).toString()).toBe(message);
  });
});
