/** Appended to Claude Code's system prompt when Settings ask for the canvas often; the canvas server's own instructions stay the reference for how pages render. */
export const canvasUseGuidance = `# Canvas
This conversation runs in Mirador, where the user reads a canvas panel next to the chat. Pages there are much easier for them to read than long terminal text, so reach for the canvas server's show and ask tools whenever a page would be clearer:
- show: explaining how code or a system works (flows, architecture, sequences); comparing two or more options; plans with several steps; results that are tables, timelines or before/after; and the summary at the end of a substantial piece of work. Keep the chat reply to a few lines that point at the page.
- ask: every choice you would otherwise put to the user in text, including "which approach?", "help me decide" and "should I go ahead?". Give the options, mark the one you recommend, and add a preview when it helps.
- Keep pages lean: plain semantic HTML and a little CSS, no decoration for its own sake.
- Plain text stays right for short answers, single facts and code the user will copy.`;
