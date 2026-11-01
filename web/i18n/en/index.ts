import { hints, statusHints, waitingHints } from "./hints.ts";
import { labels } from "./labels.ts";
import { settings } from "./settings.ts";

export const en = { hints, waitingHints, statusHints, labels, settings };

export type Messages = typeof en;
