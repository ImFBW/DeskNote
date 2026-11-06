"use strict";

const params = new URLSearchParams(location.search);
const noteId = params.get("id");
let note = null;
let preview = false;
let timer = 0;

function paint() {
  document.body.style.background = note.color || "#fffdf8";
  $("title").value = note.title || "";
  if (document.activeElement !== $("content")) $("content").value = note.content || "";
  $("preview").innerHTML = renderMarkdown(note.content || "");
  $("opacity").value = Math.round((note.opacity || 1) * 100);
  $("top").classList.toggle("on", Boolean(note.always_on_top));
  $("pin").classList.toggle("on", Boolean(note.pin_desktop));
  $("through").classList.toggle("on", Boolean(note.click_through));
  $("todos").innerHTML = (note.todos || []).map((item) => `<label class="todo"><input type="checkbox" data-id="${item.id}" ${item.done ? "checked" : ""}>${escapeHtml(item.text)}</label>`).join("");
}

function $(id) { return document.getElementById(id); }

async function load() {
  const result = await window.desknote.invoke("sticky:state", { id: noteId });
  if (!result.ok) return;
  note = result.note;
  note.todos = result.todos || [];
  paint();
}

function saveSoon() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const result = await window.desknote.invoke("note:save", {
      id: noteId,
      reason: "auto",
      fields: { title: $("title").value, content: $("content").value },
    });
    if (result.ok) note = { ...note, ...result.note };
  }, 700);
}

async function setMode(fields) {
  const result = await window.desknote.invoke("note:save", { id: noteId, reason: "manual", fields });
  if (!result.ok) return;
  note = { ...note, ...result.note };
  paint();
}

document.body.addEventListener("input", (event) => {
  if (event.target.id === "title" || event.target.id === "content") saveSoon();
});
document.body.addEventListener("change", (event) => {
  if (event.target.id === "opacity") setMode({ opacity: Number(event.target.value) / 100 });
});
$("mode").addEventListener("click", () => {
  preview = !preview;
  $("content").classList.toggle("hidden", preview);
  $("preview").classList.toggle("hidden", !preview);
  if (preview) $("preview").innerHTML = renderMarkdown($("content").value);
});
$("close").addEventListener("click", () => window.desknote.invoke("sticky:close", { id: noteId }));
$("top").addEventListener("click", () => setMode({ always_on_top: note.always_on_top ? 0 : 1 }));
$("pin").addEventListener("click", () => setMode({ pin_desktop: note.pin_desktop ? 0 : 1 }));
$("through").addEventListener("click", () => setMode({ click_through: note.click_through ? 0 : 1 }));
$("todos").addEventListener("change", (event) => {
  if (event.target.dataset.id) window.desknote.invoke("todo:toggle", { id: event.target.dataset.id }).then(load);
});
window.desknote.on("data:changed", load);
load();
