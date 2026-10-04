import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";

/**
 * How a phone on mobile data follows a conversation: the latest turns first, after a reconnect only the events it
 * missed, and each event in its low-data form, with images and long tool output left on the host until asked for.
 */
export interface LowDataSubscription {
  /** The turns to send when the phone holds none of the conversation yet; it asks for earlier ones as needed. */
  latestTurns: number;
  /** The last event the phone holds: only the events after it are sent. */
  afterSeq?: number;
}

const SHORTENED_KEY = "mirador/shortened";

/** Marks tool output that the low-data form shortened, naming the stored event whose content `tool-output.get` sends whole. */
export interface Shortened {
  seq: number;
}

export const shortenedMark = (shortened: Shortened) => ({ [SHORTENED_KEY]: shortened });

const shortenedIn = (block: ContentBlock) => (block._meta?.[SHORTENED_KEY] as Shortened | undefined) ?? null;

/** Where a tool call's output was shortened for low data, if it was. */
export const shortenedOutputOf = (content: ToolCallContent[]): Shortened | null =>
  content.flatMap((item) => (item.type === "content" ? [shortenedIn(item.content)] : [])).find((shortened) => shortened !== null) ?? null;

/** Where the host serves an image that the low-data form left out of a stored event: the event's `index`th image. */
export const eventImagePath = (conversationId: string, seq: number, index: number) => `/conversations/${conversationId}/events/${seq}/images/${index}`;
