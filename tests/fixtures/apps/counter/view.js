const page = document.createElement("main");
page.innerHTML = '<p>Count: <output id="count">…</output></p><p id="last-change"></p><p id="problem"></p><button id="add">Add one</button><p id="page-load"></p>';
document.body.append(page);
document.getElementById("page-load").textContent = crypto.randomUUID();
window.mirador.onState((state) => {
  document.getElementById("count").textContent = String(state.document.count);
  document.getElementById("last-change").textContent = state.lastChange ? `${state.lastChange.author.kind}: ${state.lastChange.summary}` : "";
  document.getElementById("problem").textContent = state.problem ?? "";
});
document.getElementById("add").addEventListener("click", () => window.mirador.apply({ op: "add", by: 1 }));
