import { canvas } from "./canvas.ts";
import { chat } from "./chat.ts";
import { dictation } from "./dictation.ts";
import { hints, statusHints, waitingHints } from "./hints.ts";
import { labels } from "./labels.ts";
import { revert } from "./revert.ts";
import { settings } from "./settings.ts";
import { shell } from "./shell.ts";
import { terminals } from "./terminals.ts";

export const en = { hints, waitingHints, statusHints, labels, settings, chat, revert, dictation, shell, canvas, terminals };

export type Messages = typeof en;
