/** What the loaded canvas plugins add to what agents are told and allowed: their tools, and a line each of guidance. */
export interface CanvasPluginGuidance {
  toolNames: string[];
  instructions: string[];
  often: string[];
}

export const NO_CANVAS_PLUGINS: CanvasPluginGuidance = { toolNames: [], instructions: [], often: [] };

const linesAfter = (lines: string[]) => lines.map((line) => `\n${line}`).join("");

/** The canvas MCP server's instructions: how its tools are meant to be used, and how pages render. */
export function canvasInstructions(assetsOrigin: string, plugins = NO_CANVAS_PLUGINS) {
  return `The canvas is a browser panel next to this conversation. The user finds long terminal text and ASCII diagrams hard to read, so prefer the canvas for anything visual.

- show: render an HTML page: architecture or flow diagrams, UI mockups, side-by-side comparisons, charts, 3D scenes, visual explanations, code-review walkthroughs.
- ask: whenever you need the user to decide between options (design choices, approaches, trade-offs), ask here instead of in plain text. Give each option a short label and, when it helps, an HTML preview. A question takes the canvas's place of what you showed before, so to ask about a page, pass it as the question's html rather than calling show first. When you have more than one thing to ask, ask them all in one call with questions, one entry each; never fold several questions into one, or offer \"accept all\" or \"change some answers\" as options.
- review: when you review code changes (a pull request or a branch), publish the review with this tool rather than show. The user reads it as a guided tour of the code flow, the diff with your findings on it, and posts the findings they keep to the pull request.
- update_review: to change parts of a review already shown (reword a finding, add or take one out, a new verdict), change just those parts with this tool; the user keeps their place in the review. Publish the whole review again only when the code under review changed.${linesAfter(plugins.instructions)}

Rendering environment: every page renders in a sandboxed iframe with NO network access (no fetch, no external CDNs, fonts or images), shown light or dark as the panel's theme is. Write self-contained HTML with inline CSS and JS, and pick every colour (background, text, cards, inline code and code blocks, borders, lines) with light-dark() so the page follows that theme, e.g. <style>html { background: light-dark(#ffffff, #111214); color: light-dark(#1c1c1e, #ececee); }</style>. Don't use @media (prefers-color-scheme): it follows the system, not the panel. A script that draws in colour reads the theme as getComputedStyle(document.documentElement).colorScheme, "light" or "dark". Available libraries:
- three.js (ES modules): <script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js";</script>
- D3 v7: <script src="${assetsOrigin}/d3.min.js"></script> (global d3)
- Mermaid: <script src="${assetsOrigin}/mermaid.min.js"></script><script>mermaid.initialize({ startOnLoad: true, theme: getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "default" })</script> with <pre class="mermaid">...</pre>
When someone is viewing the conversation, show reports back script errors from the page so you can fix them.`;
}

/** Appended to Claude Code's and pi's system prompt when Settings ask for the canvas often; the canvas server's own instructions stay the reference for how pages render. */
export const canvasUseGuidance = (plugins = NO_CANVAS_PLUGINS) => `# Canvas
This conversation runs in Mirador, where the user reads a canvas panel next to the chat. Pages there are much easier for them to read than long terminal text, so reach for the canvas server's show, tour, ask and checklist tools whenever a page would be clearer:
- show: explaining how a system works (architecture, sequences); comparing two or more options; results that are tables, timelines or before/after; and the summary at the end of a substantial piece of work that is not a code change. Keep the chat reply to a few lines that point at the page.
- ask: every choice you would otherwise put to the user in text, including "which approach?", "help me decide" and "should I go ahead?". Give the options, mark the one you recommend, and add a preview when it helps.${linesAfter(plugins.often)}
- Keep pages lean: plain semantic HTML and a little CSS, no decoration for its own sake.
- Plain text stays right for short answers, single facts and code the user will copy.`;
