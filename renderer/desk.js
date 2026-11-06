"use strict";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "note";
const itemId = params.get("id");
const COLORS = ["#fffdf8", "#fff4c8", "#ffe7d4", "#fde4ec", "#e5f6ee", "#e5f1fb", "#efe6fb"];
const FONTS = [["", "默认"], ["Microsoft YaHei", "微软雅黑"], ["SimSun", "宋体"], ["KaiTi", "楷体"], ["Segoe UI", "Segoe UI"], ["Consolas", "等宽"], ["Georgia", "Georgia"]];
let item = null;
let preview = false;
let timer = 0;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function surface() {
  return {
    color: item.color,
    bg_transparent: $("bg-transparent") ? ($("bg-transparent").checked ? 1 : 0) : item.bg_transparent,
    font_family: $("font-family") ? $("font-family").value : item.font_family,
    font_size: $("font-size") ? Number($("font-size").value) : item.font_size,
    font_color: $("font-color") ? $("font-color").value : item.font_color,
    font_bold: $("font-bold") ? ($("font-bold").checked ? 1 : 0) : item.font_bold,
    font_italic: $("font-italic") ? ($("font-italic").checked ? 1 : 0) : item.font_italic,
    opacity: $("opacity") ? Number($("opacity").value) / 100 : item.opacity,
    always_on_top: item.always_on_top,
    pin_desktop: item.pin_desktop,
    click_through: item.click_through,
    position_locked: item.position_locked,
  };
}

function applyLook() {
  document.body.style.background = item.bg_transparent ? "transparent" : (item.color || "#fffdf8");
  document.body.style.fontFamily = item.font_family || '"Segoe UI", "Microsoft YaHei", sans-serif';
  document.body.style.fontSize = `${item.font_size || 15}px`;
  document.body.style.color = item.font_color || "#243036";
  document.body.style.fontWeight = item.font_bold ? "700" : "400";
  document.body.style.fontStyle = item.font_italic ? "italic" : "normal";
  document.body.classList.toggle("stuck", Boolean(item.pin_desktop));
  document.body.classList.toggle("locked", Boolean(item.position_locked));
  $("top").classList.toggle("on", Boolean(item.always_on_top));
  $("pin").classList.toggle("on", Boolean(item.pin_desktop));
  $("through").classList.toggle("on", Boolean(item.click_through));
  $("lock").classList.toggle("on", Boolean(item.position_locked));
}

function paint() {
  applyLook();
  if (document.activeElement !== $("title")) $("title").value = item.title || item.text || "";
  if (kind === "note") paintNote();
  if (kind === "todo") paintTodo();
  if (kind === "reminder") paintReminder();
  if ($("style-panel") && !$("style-panel").classList.contains("hidden") && !$("style-panel").contains(document.activeElement)) paintStyle();
}

function paintNote() {
  const content = $("content");
  if (!content) {
    $("body").innerHTML = `<textarea id="content"></textarea><article id="preview" class="preview hidden"></article><div class="row"><button type="button" id="mode">预览</button><button type="button" id="remove">删除</button></div>`;
    $("content").value = item.content || "";
    $("mode").addEventListener("click", togglePreview);
    $("remove").addEventListener("click", removeItem);
    return;
  }
  if (document.activeElement !== content) content.value = item.content || "";
  const view = $("preview");
  if (view) view.innerHTML = renderMarkdown(content.value || "");
}

function paintTodo() {
  if (!$("done")) {
    $("body").innerHTML = `<label class="row check"><input id="done" type="checkbox"> 完成</label><button type="button" id="remove">删除</button>`;
    $("done").addEventListener("change", () => saveNow());
    $("remove").addEventListener("click", removeItem);
  }
  if (document.activeElement !== $("done")) $("done").checked = Boolean(item.done);
}

function paintReminder() {
  if (!$("remind-at")) {
    $("body").innerHTML = `<input id="remind-at" type="datetime-local"><div class="row"><select id="repeat"><option value="none">只提醒一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="interval">每隔一段时间</option></select><input id="interval" type="number" min="1" value="30" style="width:72px"></div><input id="weekdays" placeholder="每周：0,1,2,3,4"><label class="row"><input id="sound" type="checkbox"> 声音</label><label class="row"><input id="enabled" type="checkbox"> 启用</label><button type="button" id="remove">删除</button>`;
    ["remind-at", "repeat", "interval", "weekdays", "sound", "enabled"].forEach((id) => $(id).addEventListener("change", saveSoon));
    $("remove").addEventListener("click", removeItem);
  }
  if (document.activeElement !== $("remind-at")) $("remind-at").value = localInput(item.remind_at);
  if (!$("repeat").matches(":focus")) $("repeat").value = item.repeat_rule || "none";
  if (document.activeElement !== $("interval")) $("interval").value = item.interval_minutes || 30;
  if (document.activeElement !== $("weekdays")) $("weekdays").value = item.weekdays || "";
  $("sound").checked = item.sound !== 0;
  $("enabled").checked = item.enabled !== 0;
}

function paintStyle() {
  const fontOptions = FONTS.map(([value, label]) => `<option value="${value}" ${value === (item.font_family || "") ? "selected" : ""}>${label}</option>`).join("");
  const swatches = COLORS.map((color) => `<button type="button" data-color="${color}" style="background:${color}"></button>`).join("");
  $("style-panel").innerHTML = `<div class="swatches">${swatches}</div>
    <label class="row"><input id="bg-transparent" type="checkbox" ${item.bg_transparent ? "checked" : ""}> 透明背景</label>
    <div class="row"><select id="font-family">${fontOptions}</select><input id="font-size" type="number" min="12" max="48" value="${item.font_size || 15}" style="width:64px"><input id="font-color" type="color" value="${item.font_color || "#243036"}"></div>
    <label class="row"><input id="font-bold" type="checkbox" ${item.font_bold ? "checked" : ""}> 粗体</label>
    <label class="row"><input id="font-italic" type="checkbox" ${item.font_italic ? "checked" : ""}> 斜体</label>
    <label class="row">不透明度 <input id="opacity" type="range" min="15" max="100" value="${Math.round((item.opacity || 1) * 100)}"></label>`;
}

function localInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function load() {
  const result = await window.desknote.invoke("desk:state", { kind, id: itemId });
  if (!result.ok) {
    $("status").textContent = result.error || "读取失败";
    return;
  }
  item = result.item;
  paint();
}

function contentFields() {
  if (kind === "note") return { title: $("title").value, content: $("content") ? $("content").value : (item.content || "") };
  if (kind === "todo") return { text: $("title").value, done: $("done") && $("done").checked ? 1 : 0, note_id: item.note_id };
  return {
    title: $("title").value,
    remind_at: $("remind-at") ? $("remind-at").value : item.remind_at,
    repeat_rule: $("repeat") ? $("repeat").value : item.repeat_rule,
    interval_minutes: $("interval") ? Number($("interval").value) : item.interval_minutes,
    weekdays: $("weekdays") ? $("weekdays").value : item.weekdays,
    sound: $("sound") && $("sound").checked ? 1 : 0,
    enabled: $("enabled") && $("enabled").checked ? 1 : 0,
    note_id: item.note_id || "",
  };
}

async function saveNow(extra) {
  const payload = { id: itemId, ...contentFields(), ...(extra || {}) };
  const channel = kind === "note" ? "note:save" : kind === "todo" ? "todo:save" : "reminder:save";
  const body = kind === "note" ? { id: itemId, reason: "auto", fields: payload } : payload;
  const result = await window.desknote.invoke(channel, body);
  $("status").textContent = result.ok ? "" : (result.error || "没有保存");
  if (result.ok) item = result.note || result.todo || result.reminder || item;
  applyLook();
}

function saveSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => saveNow(), 700);
}

function togglePreview() {
  preview = !preview;
  $("content").classList.toggle("hidden", preview);
  $("preview").classList.toggle("hidden", !preview);
  if (preview) $("preview").innerHTML = renderMarkdown($("content").value);
}

async function removeItem() {
  await window.desknote.invoke("desk:delete", { kind, id: itemId });
}

document.body.addEventListener("input", (event) => {
  if (["title", "content"].includes(event.target.id)) saveSoon();
});
document.body.addEventListener("change", (event) => {
  if (["bg-transparent", "font-family", "font-size", "font-color", "font-bold", "font-italic", "opacity"].includes(event.target.id)) saveNow(surface());
});
$("style").addEventListener("click", () => {
  const panel = $("style-panel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) paintStyle();
});
$("style-panel").addEventListener("click", (event) => {
  const color = event.target.dataset.color;
  if (!color) return;
  item.color = color;
  saveNow({ ...surface(), color });
});
$("close").addEventListener("click", () => window.desknote.invoke("desk:close", { kind, id: itemId }));
$("top").addEventListener("click", () => saveNow({ always_on_top: item.always_on_top ? 0 : 1, pin_desktop: 0 }));
$("pin").addEventListener("click", () => {
  const on = item.pin_desktop ? 0 : 1;
  $("status").textContent = on ? "已贴进桌面，显示桌面时还会留在桌面上" : "已离开桌面层";
  saveNow({ pin_desktop: on, always_on_top: 0 });
});
$("through").addEventListener("click", () => {
  const on = item.click_through ? 0 : 1;
  $("status").textContent = on ? "已穿透。按 Ctrl+Alt+P 或桌面条可以关掉" : "已关闭穿透";
  saveNow({ click_through: on });
});
$("lock").addEventListener("click", () => {
  const on = item.position_locked ? 0 : 1;
  $("status").textContent = on ? "位置已锁定" : "位置已解锁";
  saveNow({ position_locked: on });
});
window.desknote.on("data:changed", load);
load();
