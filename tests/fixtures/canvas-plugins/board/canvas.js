const page = document.createElement("main");
page.innerHTML = `<h1 id="title"></h1><p id="text"></p><p id="type"></p><p id="unseen"></p>
<button id="press">Press</button><p id="reply"></p><button id="refused">Do what cards don't</button>
<span id="hinted" data-hint="What the board says about itself.">Hover me</span>
<a id="link" href="https://example.invalid/board">The board's site</a>
<p id="theme" style="color: var(--mirador-text); font-size: calc(10px * var(--mirador-font-scale))">Themed</p>
<p id="fullscreen"></p><button id="toggle-fullscreen">Toggle full screen</button>
<p id="typing"></p><p id="found"></p>
<textarea id="question" aria-label="Question"></textarea><button id="ask">Ask the agent</button><p id="asked"></p>`;
document.body.append(page);
const show = (id, text) => (document.getElementById(id).textContent = text);
const textOf = (item) => {
  if (item.type === "card") return `${item.data.text} (pressed ${item.data.presses} times)`;
  if (item.type === "report") return `Verdict: ${item.data.verdict}`;
  return `${item.data.done} of ${item.data.steps.length} steps done`;
};
const isUnseen = (item, { seenAgentEditAt }) => item.agentEditedAt !== null && (seenAgentEditAt === null || item.agentEditedAt > seenAgentEditAt);
let fullscreen;
let finds = false;
let found = 0;
window.mirador.onItem((item, context) => {
  show("title", item.title);
  show("type", item.type);
  show("text", textOf(item));
  show("unseen", isUnseen(item, context) ? "Changed since you looked" : "Nothing new");
  show("fullscreen", context.fullscreen === undefined ? "No full screen here" : context.fullscreen ? "Full screen" : "Beside the chat");
  show("typing", `Autocorrect ${context.typingAids?.autocorrect ? "on" : "off"}`);
  fullscreen = context.fullscreen;
  finds = item.type === "report";
});
addEventListener("keydown", (event) => {
  if (!finds || !(event.metaKey || event.ctrlKey) || event.code !== "KeyF") return;
  event.preventDefault();
  show("found", `Found ${++found} times`);
});
document.getElementById("toggle-fullscreen").addEventListener("click", () => window.mirador.setFullscreen(!fullscreen));
document.getElementById("ask").addEventListener("click", () =>
  window.mirador.prompt(document.getElementById("question").value).then(() => show("asked", "Asked"), (error) => show("asked", error.message)),
);
document.getElementById("press").addEventListener("click", () =>
  window.mirador.send({ kind: "press" }).then(({ presses }) => show("reply", `Pressed ${presses} times`), (error) => show("reply", error.message)),
);
document.getElementById("refused").addEventListener("click", () => window.mirador.send({ kind: "fold" }).catch((error) => show("reply", error.message)));
