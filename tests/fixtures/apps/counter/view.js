const page = document.createElement("main");
page.innerHTML = '<p>Count: <output id="count">…</output></p><p id="last-change"></p><p id="problem"></p><button id="add">Add one</button><button id="ask">Ask about the count</button><button id="read-note">Read the note</button><button id="read-outside">Read the file outside</button><p id="file-text"></p><p id="page-load"></p><button id="remember">Remember the count</button><p id="remembered"></p><p id="same-storage"></p>';
document.body.append(page);
document.getElementById("page-load").textContent = crypto.randomUUID();
window.mirador.onState((state) => {
  document.getElementById("count").textContent = String(state.document.count);
  document.getElementById("last-change").textContent = state.lastChange ? `${state.lastChange.author.kind}: ${state.lastChange.summary}` : "";
  document.getElementById("problem").textContent = state.problem ?? "";
});
document.getElementById("add").addEventListener("click", () => window.mirador.apply({ op: "add", by: 1 }));
document.getElementById("ask").addEventListener("click", () => window.mirador.prompt(`Is ${document.getElementById("count").textContent} a good count?`));
const showFile = (path) => window.mirador.readFile(path).then((blob) => blob.text()).catch((error) => error.message).then((text) => (document.getElementById("file-text").textContent = text));
document.getElementById("read-note").addEventListener("click", () => showFile("note.txt"));
document.getElementById("read-outside").addEventListener("click", () => showFile("../outside.txt"));
document.getElementById("remembered").textContent = localStorage.getItem("remembered") ?? "nothing remembered";
document.getElementById("same-storage").textContent = window.mirador.storage === localStorage ? "localStorage is the app's storage" : "localStorage is the frame's own";
document.getElementById("remember").addEventListener("click", () => localStorage.setItem("remembered", `the count was ${document.getElementById("count").textContent}`));
