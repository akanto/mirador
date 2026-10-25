const page = document.createElement("main");
page.innerHTML = '<h1 id="title"></h1><p id="text"></p><p id="type"></p><button id="press">Press</button><p id="reply"></p><button id="refused">Do what cards don\'t</button>';
document.body.append(page);
const show = (id, text) => (document.getElementById(id).textContent = text);
window.mirador.onItem((item) => {
  show("title", item.title);
  show("type", item.type);
  show("text", item.type === "card" ? `${item.data.text} (pressed ${item.data.presses} times)` : `${item.data.done} of ${item.data.steps.length} steps done`);
});
document.getElementById("press").addEventListener("click", () =>
  window.mirador.send({ kind: "press" }).then(({ presses }) => show("reply", `Pressed ${presses} times`), (error) => show("reply", error.message)),
);
document.getElementById("refused").addEventListener("click", () => window.mirador.send({ kind: "fold" }).catch((error) => show("reply", error.message)));
