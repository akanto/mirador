import { chat } from "./chat.ts";
import { dictation } from "./dictation.ts";
import { hints, statusHints, waitingHints } from "./hints.ts";
import { labels } from "./labels.ts";
import { revert } from "./revert.ts";
import { settings } from "./settings.ts";

export const en = { hints, waitingHints, statusHints, labels, settings, chat, revert, dictation };

export type Messages = typeof en;
