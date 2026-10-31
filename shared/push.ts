/** Every push blob has this many bytes before base64, whatever it says, so neither the relay nor Apple or Google can tell pushes apart by size. */
export const PUSH_BLOB_BYTES = 2048;

export type PushPlatform = "ios" | "android";

/** An alert carries a blob encrypted to the phone; a Live Activity's end push carries nothing of the Mac's, only a fixed placeholder. */
export type PushKind = "alert" | "live-activity-end";

/** What a Mac posts to the push relay's /push. */
export interface PushRequest {
  platform: PushPlatform;
  /** The token Apple or Google gave the phone, or for a Live Activity end push the activity's own push token. */
  deviceToken: string;
  /** For iPhone builds signed for development, which Apple serves from its sandbox. */
  sandbox?: boolean;
  kind: PushKind;
  /** Base64 of exactly PUSH_BLOB_BYTES bytes, for an alert only. */
  blob?: string;
}

/** What the relay answers: `gone` means the phone's token is dead, so the Mac forgets it. */
export type PushOutcome = "sent" | "gone" | "failed";
