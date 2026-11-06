"use strict";

const COLORS = ["#fffdf8", "#fff4c8", "#ffe7d4", "#fde4ec", "#e5f6ee", "#e5f1fb", "#efe6fb"];
const EMOJI = {
  表情: ["😀", "😁", "😂", "😊", "😉", "😍", "😘", "🤔", "😎", "😢", "👍", "👏", "🙏", "💪"],
  工作: ["✅", "📌", "📅", "⏰", "📝", "📎", "💡", "❗", "❓", "🚀", "🎯"],
  生活: ["☕", "🌙", "⭐", "🌈", "🔥", "❤️", "🏠", "📚", "🎵", "🍎"],
};
const state = {
  view: "notes",
  categoryId: "all",
  noteId: null,
  query: "",
  mode: "split",
  categories: [],
  notes: [],
  todos: [],
  reminders: [],
  settings: {},
  shortcuts: [],
  logs: [],
  logKind: "op",
  manual: "",
  version: "",
};
let editorDirty = false;
let saveTimer = 0;
let recording = null;

const $ = (id) => document.getElementById(id);

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2400);
}

async function call(channel, payload) {
  const result = await window.desknote.invoke(channel, payload || {});
  if (!result.ok) {
    toast(result.error || "操作失败");
    const error = new Error(result.error || "操作失败");
    error.soft = true;
    throw error;
  }
  return result;
}

function selected() {
  return state.notes.find((note) => note.id === state.noteId) || null;
}

function categoryName(id) {
  return (state.categories.find((item) => item.id === id) || {}).name || "未分类";
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function excerpt(text) {
  return String(text || "").replace(/[#>*_`\-[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 42);
}

function applyData(data) {
  state.categories = data.categories || [];
  state.notes = data.notes || [];
  state.todos = data.todos || [];
  state.reminders = data.reminders || [];
  state.settings = data.settings || {};
  state.shortcuts = data.shortcuts || [];
  state.version = data.version || state.version;
  document.body.dataset.theme = state.settings.theme || "paper";
}

function visibleNotes() {
  return state.notes.filter((note) => {
    if (state.categoryId === "archived") return note.archived;
    if (note.archived) return false;
    if (state.categoryId === "todo") return note.note_type === "todo";
    if (state.categoryId !== "all" && note.category_id !== state.categoryId) return false;
    if (!state.query) return true;
    const hay = `${note.title}\n${note.content}`.toLowerCase();
    return hay.includes(state.query.toLowerCase());
  });
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".rail button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  ["notes", "todos", "reminders", "logs", "settings", "help"].forEach((name) => {
    const node = $(`view-${name}`);
    node.classList.toggle("hidden", name !== view);
    if (name === "notes") node.classList.toggle("workspace", name === view);
  });
  render();
}

function render() {
  renderStatus();
  if (state.view === "notes") renderNotes();
  if (state.view === "todos") renderTodos();
  if (state.view === "reminders") renderReminders();
  if (state.view === "logs") renderLogs();
  if (state.view === "settings") renderSettings();
  if (state.view === "help") renderHelp();
}

function renderStatus() {
  const sync = state.settings.logged_in
    ? `已登录 ${state.settings.sync_username || ""} · ${state.settings.last_sync_at ? `上次同步 ${formatTime(state.settings.last_sync_at)}` : "尚未同步"}`
    : "本地模式，未登录";
  $("status").textContent = `DeskNote ${state.version || ""} · ${sync}`;
}

function renderNotes() {
  const cats = [
    ["all", "全部"],
    ["todo", "待办"],
    ["archived", "已归档"],
  ].map(([id, name]) => `<button type="button" class="cat ${state.categoryId === id ? "active" : ""}" data-act="cat" data-id="${id}">${name}</button>`).join("");
  const custom = state.categories.map((item) => `<button type="button" class="cat ${state.categoryId === item.id ? "active" : ""}" data-act="cat" data-id="${item.id}"><i class="swatch" style="background:${item.color};display:inline-block"></i> ${escapeHtml(item.name)}</button>`).join("");
  $("cats").innerHTML = `<div class="row between"><strong>分类</strong><button type="button" class="btn-quiet" data-act="add-cat">＋</button></div>
    <input id="search" class="search" placeholder="搜索标题或正文" value="${escapeHtml(state.query)}">
    ${cats}${custom}`;
  const search = $("search");
  if (search) search.setSelectionRange(state.query.length, state.query.length);
  const notes = visibleNotes().map((note) => `<button type="button" class="note-item ${note.id === state.noteId ? "active" : ""}" data-act="select" data-id="${note.id}">
      <i class="swatch" style="background:${note.color}"></i>
      <span><span class="note-title">${escapeHtml(note.title || "未命名")}</span><br><span class="note-excerpt">${escapeHtml(excerpt(note.content))}</span><br><span class="note-meta">${escapeHtml(categoryName(note.category_id))} · ${formatTime(note.updated_at)}</span></span>
    </button>`).join("");
  $("list").innerHTML = `<div class="row" style="margin-bottom:10px"><button type="button" class="btn" data-act="new-note">新建便签</button><button type="button" class="btn-quiet" data-act="new-todo">待办</button></div>${notes || '<p class="muted">这里还没有便签。</p>'}`;
  renderEditor();
}

function renderEditor() {
  const note = selected();
  if (!note) {
    $("editor").innerHTML = '<div class="pad muted">选一张便签，或新建一张。</div>';
    $("props").innerHTML = "";
    return;
  }
  const editingSame = $("content") && $("content").dataset.id === note.id;
  if (editingSame && editorDirty) return;
  const todos = state.todos.filter((item) => item.note_id === note.id);
  $("editor").innerHTML = `<header>
      <input id="title" class="title" data-id="${note.id}" value="${escapeHtml(note.title)}">
      <div class="modes">
        <button type="button" data-act="mode" data-mode="edit" class="${state.mode === "edit" ? "active" : ""}">编辑</button>
        <button type="button" data-act="mode" data-mode="preview" class="${state.mode === "preview" ? "active" : ""}">预览</button>
        <button type="button" data-act="mode" data-mode="split" class="${state.mode === "split" ? "active" : ""}">分栏</button>
      </div>
    </header>
    <div class="split">
      <textarea id="content" data-id="${note.id}" class="area ${state.mode === "preview" ? "hidden" : ""}">${escapeHtml(note.content)}</textarea>
      <article id="preview" class="preview ${state.mode === "edit" ? "hidden" : ""}">${renderMarkdown(note.content)}</article>
    </div>
    ${note.note_type === "todo" ? `<div class="pad" id="todo-box">${renderTodoBox(todos)}</div>` : ""}`;
  const options = [`<option value="">未分类</option>`].concat(state.categories.map((item) => `<option value="${item.id}" ${item.id === note.category_id ? "selected" : ""}>${escapeHtml(item.name)}</option>`)).join("");
  const colors = COLORS.map((color) => `<button type="button" data-act="color" data-color="${color}" class="${note.color === color ? "active" : ""}" style="background:${color}"></button>`).join("");
  const emoji = Object.entries(EMOJI).map(([group, icons]) => `<div class="muted">${group}</div><div class="emoji">${icons.map((icon) => `<button type="button" data-act="emoji" data-emoji="${icon}">${icon}</button>`).join("")}</div>`).join("");
  $("props").innerHTML = `<div class="field"><label>分类</label><select id="category" class="text">${options}</select></div>
    <div class="field"><label>纸色</label><div class="colors">${colors}</div></div>
    <label class="row"><input id="pinned" type="checkbox" ${note.pinned ? "checked" : ""}> 列表置顶</label>
    <label class="row"><input id="archived" type="checkbox" ${note.archived ? "checked" : ""}> 归档</label>
    <label class="row"><input id="on-desktop" type="checkbox" ${note.on_desktop ? "checked" : ""}> 放到桌面</label>
    <label class="row"><input id="pin-desktop" type="checkbox" ${note.pin_desktop ? "checked" : ""}> 贴进桌面</label>
    <label class="row"><input id="lock-pos" type="checkbox" ${note.position_locked ? "checked" : ""}> 锁定位置</label>
    <label class="row"><input id="on-top" type="checkbox" ${note.always_on_top ? "checked" : ""}> 窗口置顶</label>
    <label class="row"><input id="through" type="checkbox" ${note.click_through ? "checked" : ""}> 鼠标穿透</label>
    <div class="field"><label>不透明度 <span id="opacity-label">${Math.round(note.opacity * 100)}%</span></label><input id="opacity" type="range" min="15" max="100" value="${Math.round((note.opacity || 1) * 100)}"></div>
    <label class="row"><input id="bg-transparent" type="checkbox" ${note.bg_transparent ? "checked" : ""}> 透明背景</label>
    <div class="field"><label>字体</label><select id="font-family" class="text"><option value="">默认</option><option value="Microsoft YaHei" ${note.font_family === "Microsoft YaHei" ? "selected" : ""}>微软雅黑</option><option value="SimSun" ${note.font_family === "SimSun" ? "selected" : ""}>宋体</option><option value="KaiTi" ${note.font_family === "KaiTi" ? "selected" : ""}>楷体</option><option value="Consolas" ${note.font_family === "Consolas" ? "selected" : ""}>等宽</option></select></div>
    <div class="row"><input id="font-size" class="text" type="number" min="12" max="48" value="${note.font_size || 15}"><input id="font-color" type="color" value="${note.font_color || "#243036"}"></div>
    <label class="row"><input id="font-bold" type="checkbox" ${note.font_bold ? "checked" : ""}> 粗体</label>
    <label class="row"><input id="font-italic" type="checkbox" ${note.font_italic ? "checked" : ""}> 斜体</label>
    <div class="row"><button type="button" class="btn" data-act="save">保存</button><button type="button" class="btn-quiet" data-act="open-sticky">打开桌面便签</button></div>
    <button type="button" class="btn-danger" data-act="delete-note" style="margin-top:12px">删除</button>
    <details open><summary>表情</summary>${emoji}</details>`;
}

function renderTodoBox(todos) {
  const lines = todos.map((item) => `<label class="todo-line ${item.done ? "done" : ""}"><input type="checkbox" data-act="toggle-todo" data-id="${item.id}" ${item.done ? "checked" : ""}><span>${escapeHtml(item.text)}</span><button type="button" class="btn-quiet" data-act="delete-todo" data-id="${item.id}">删</button></label>`).join("");
  return `<strong>待办项</strong>${lines}<div class="row" style="margin-top:8px"><input id="new-todo-text" class="text grow" placeholder="新增一项"><button type="button" class="btn" data-act="add-todo">添加</button></div>`;
}

function renderTodos() {
  const groups = state.notes.filter((note) => note.note_type === "todo" && !note.deleted).map((note) => {
    const items = state.todos.filter((item) => item.note_id === note.id);
    return `<article class="card"><div class="row between"><strong>${escapeHtml(note.title)}</strong><button type="button" class="btn-quiet" data-act="select-open" data-id="${note.id}">打开</button><button type="button" class="btn-quiet" data-act="desk-open" data-kind="note" data-id="${note.id}">放到桌面</button></div>${items.map((item) => `<div class="row between"><span>${escapeHtml(item.text)}</span><button type="button" class="btn-quiet" data-act="desk-open" data-kind="todo" data-id="${item.id}">放到桌面</button></div>`).join("")}${renderTodoBox(items)}</article>`;
  }).join("");
  $("view-todos").innerHTML = `<h1>待办</h1><button type="button" class="btn" data-act="new-todo">新建待办</button>${groups || '<p class="muted">还没有待办。</p>'}`;
}

function renderReminders() {
  const items = state.reminders.map((item) => `<article class="rem-item">
      <div class="grow"><div class="rem-title">${escapeHtml(item.title)}</div><div class="muted">${labelRule(item)} · ${formatTime(item.next_fire_at || item.remind_at)} · ${item.enabled ? "启用" : "关闭"}</div></div>
      <button type="button" class="btn-quiet" data-act="desk-open" data-kind="reminder" data-id="${item.id}">放到桌面</button>
      <button type="button" class="btn-quiet" data-act="delete-reminder" data-id="${item.id}">删除</button>
    </article>`).join("");
  const noteOptions = ['<option value="">不关联便签</option>'].concat(state.notes.map((note) => `<option value="${note.id}">${escapeHtml(note.title)}</option>`)).join("");
  $("view-reminders").innerHTML = `<h1>提醒</h1><p class="muted">到点后弹出桌面气泡。声音可在设置里关闭。错过超过 12 小时的旧提醒不会补响。</p>
    <form id="reminder-form" class="card">
      <div class="field"><label>标题</label><input name="title" class="text" required></div>
      <div class="field"><label>时间</label><input name="remind_at" class="text" type="datetime-local" required></div>
      <div class="row">
        <select name="repeat_rule" class="text"><option value="none">只提醒一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="interval">每隔一段时间</option></select>
        <input name="interval_minutes" class="text" type="number" min="1" placeholder="间隔分钟" value="30">
      </div>
      <div class="field"><label>每周（周一为 0）</label><input name="weekdays" class="text" placeholder="例如 0,1,2,3,4"></div>
      <div class="field"><label>关联便签</label><select name="note_id" class="text">${noteOptions}</select></div>
      <label class="row"><input name="sound" type="checkbox" checked> 播放提示音</label>
      <label class="row"><input name="enabled" type="checkbox" checked> 启用</label>
      <div class="row"><button class="btn" type="submit">保存提醒</button><button type="button" class="btn-quiet" data-act="check-reminders">立即检查</button></div>
    </form>${items || '<p class="muted">还没有提醒。</p>'}`;
}

function labelRule(item) {
  const names = { none: "一次", daily: "每天", weekly: "每周", monthly: "每月", interval: `每 ${item.interval_minutes} 分钟` };
  return names[item.repeat_rule] || item.repeat_rule;
}

async function renderLogs() {
  let data = { logs: state.logs };
  try { data = await call("logs:list", { kind: state.logKind, limit: 300, query: state.logQuery || "" }); } catch (_error) { return; }
  state.logs = data.logs || [];
  const rowsHtml = state.logs.map((row) => state.logKind === "error"
    ? `<tr><td>${escapeHtml(formatTime(row.ts))}</td><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.message)}</td></tr>`
    : `<tr><td>${escapeHtml(formatTime(row.ts))}</td><td>${row.ok ? "成功" : "失败"}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.detail || "")}</td></tr>`).join("");
  const head = state.logKind === "error" ? "<tr><th>时间</th><th>来源</th><th>内容</th></tr>" : "<tr><th>时间</th><th>结果</th><th>动作</th><th>详情</th></tr>";
  $("view-logs").innerHTML = `<h1>日志</h1><div class="row">
      <button type="button" class="btn ${state.logKind === "op" ? "" : "btn-quiet"}" data-act="log-kind" data-kind="op">操作</button>
      <button type="button" class="btn ${state.logKind === "error" ? "" : "btn-quiet"}" data-act="log-kind" data-kind="error">错误</button>
      <input id="log-query" class="text grow" placeholder="筛选" value="${escapeHtml(state.logQuery || "")}">
      <button type="button" class="btn-quiet" data-act="export-logs">导出</button>
      <button type="button" class="btn-quiet" data-act="open-logs">打开日志目录</button>
    </div><table class="table">${head}${rowsHtml}</table>`;
}

function renderSettings() {
  const rowsHtml = state.shortcuts.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${item.scope === "global" ? "全局" : "窗口内"}</td><td><input class="text shortcut" data-action="${item.action}" value="${escapeHtml(item.keys)}"></td><td><button type="button" class="btn-quiet" data-act="record" data-action="${item.action}">录制</button></td></tr>`).join("");
  $("view-settings").innerHTML = `<h1>设置</h1>
    <section class="card"><h2>外观和运行</h2>
      <label class="row"><input id="set-sound" type="checkbox" ${state.settings.sound_enabled !== "0" ? "checked" : ""}> 允许提示音</label>
      <label class="row"><input id="set-tray" type="checkbox" ${state.settings.close_to_tray !== "0" ? "checked" : ""}> 关闭主窗口时留在托盘</label>
      <label class="row"><input id="set-start" type="checkbox" ${state.settings.autostart === "1" ? "checked" : ""}> 开机启动</label>
      <label class="row"><input id="set-main" type="checkbox" ${state.settings.show_main_on_start === "1" ? "checked" : ""}> 启动时打开主窗口</label>
      <div class="field"><label>桌面卡片上限</label><input id="set-limit" class="text" type="number" min="1" max="30" value="${escapeHtml(state.settings.desktop_limit || "8")}"></div>
      <div class="field"><label>主题</label><select id="set-theme" class="text"><option value="paper" ${state.settings.theme !== "ink" ? "selected" : ""}>纸色</option><option value="ink" ${state.settings.theme === "ink" ? "selected" : ""}>墨色</option></select></div>
      <div class="field"><label>自动同步间隔（分钟，0 表示关闭）</label><input id="set-sync-min" class="text" type="number" min="0" max="1440" value="${escapeHtml(state.settings.auto_sync_minutes || "0")}"></div>
      <div class="row"><button type="button" class="btn" data-act="save-settings">保存设置</button><button type="button" class="btn-quiet" data-act="test-sound">试听提示音</button></div>
    </section>
    <section class="card"><h2>快捷键</h2><p class="muted">全局快捷键写成 ctrl+alt+n。窗口内快捷键只在 DeskNote 处于前台时生效。macOS 上若全局快捷键无效，请在系统设置里允许辅助功能。</p>
      <table class="table"><tr><th>动作</th><th>范围</th><th>按键</th><th></th></tr>${rowsHtml}</table>
    </section>
    <section class="card"><h2>同步</h2><p class="muted">不登录也可以使用。只有把数据同步到服务器时才需要账号。</p>
      <div class="field"><label>服务器</label><input id="sync-server" class="text" placeholder="http://127.0.0.1:8787" value="${escapeHtml(state.settings.sync_server || "")}"></div>
      <div class="row"><input id="sync-user" class="text" placeholder="用户名" value="${escapeHtml(state.settings.sync_username || "")}"><input id="sync-pass" class="text" type="password" placeholder="密码"></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn" data-act="login">登录</button><button type="button" class="btn-quiet" data-act="register">注册并登录</button><button type="button" class="btn-quiet" data-act="sync">立即同步</button><button type="button" class="btn-quiet" data-act="logout">退出登录</button></div>
    </section>
    <section class="card"><h2>数据位置</h2><p class="muted">数据库、操作日志和错误日志都在本机用户目录。密码不会写入日志。</p>
      <button type="button" class="btn-quiet" data-act="open-data">打开数据目录</button></section>`;
}

async function renderHelp() {
  if (!state.manual) {
    try { state.manual = (await call("help:manual")).markdown || ""; } catch (_error) { state.manual = "说明书读取失败。"; }
  }
  $("view-help").innerHTML = `<article class="card preview">${renderMarkdown(state.manual)}</article>`;
}

async function reload(keepEditor) {
  const data = await call("bootstrap");
  const dirty = editorDirty;
  const current = state.noteId;
  applyData(data);
  state.noteId = current;
  if (!keepEditor && !dirty) editorDirty = false;
  render();
}

async function saveCurrent(reason) {
  const note = selected();
  const title = $("title");
  const content = $("content");
  if (!note || !title || !content) return;
  const fields = {
    title: title.value,
    content: content.value,
    category_id: $("category") ? $("category").value : note.category_id,
    pinned: $("pinned") ? $("pinned").checked : note.pinned,
    archived: $("archived") ? $("archived").checked : note.archived,
    on_desktop: $("on-desktop") ? $("on-desktop").checked : note.on_desktop,
    pin_desktop: $("pin-desktop") ? $("pin-desktop").checked : note.pin_desktop,
    position_locked: $("lock-pos") ? $("lock-pos").checked : note.position_locked,
    always_on_top: $("on-top") ? $("on-top").checked : note.always_on_top,
    click_through: $("through") ? $("through").checked : note.click_through,
    opacity: $("opacity") ? Number($("opacity").value) / 100 : note.opacity,
    bg_transparent: $("bg-transparent") ? $("bg-transparent").checked : note.bg_transparent,
    font_family: $("font-family") ? $("font-family").value : note.font_family,
    font_size: $("font-size") ? Number($("font-size").value) : note.font_size,
    font_color: $("font-color") ? $("font-color").value : note.font_color,
    font_bold: $("font-bold") ? $("font-bold").checked : note.font_bold,
    font_italic: $("font-italic") ? $("font-italic").checked : note.font_italic,
  };
  const result = await call("note:save", { id: note.id, reason, fields });
  editorDirty = false;
  Object.assign(note, result.note);
  if (reason === "manual") toast("已保存");
  renderStatus();
  const active = document.activeElement;
  if (!active || (active.id !== "title" && active.id !== "content" && active.id !== "search")) renderNotes();
}

function scheduleSave() {
  editorDirty = true;
  const preview = $("preview");
  const content = $("content");
  if (preview && content && state.mode !== "edit") preview.innerHTML = renderMarkdown(content.value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrent("auto").catch(() => {}), 800);
}

function insertAtCursor(text) {
  const area = $("content");
  if (!area) return;
  const start = area.selectionStart;
  area.value = `${area.value.slice(0, start)}${text}${area.value.slice(area.selectionEnd)}`;
  area.selectionStart = area.selectionEnd = start + text.length;
  area.focus();
  scheduleSave();
}

function shortcutCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("cmd");
  let key = event.key.toLowerCase();
  if (["control", "alt", "shift", "meta"].includes(key)) return parts.join("+");
  if (key === " ") key = "space";
  if (key === "escape") key = "esc";
  parts.push(key);
  return parts.join("+");
}

function currentShortcuts() {
  return [...document.querySelectorAll(".shortcut")].map((input) => {
    const original = state.shortcuts.find((item) => item.action === input.dataset.action) || {};
    return { action: input.dataset.action, keys: input.value.trim().toLowerCase(), scope: original.scope, label: original.label };
  });
}

document.body.addEventListener("click", async (event) => {
  const node = event.target.closest("[data-act], [data-view]");
  if (!node) return;
  if (node.dataset.view) {
    switchView(node.dataset.view);
    return;
  }
  const act = node.dataset.act;
  try {
    if (act === "cat") state.categoryId = node.dataset.id;
    if (act === "select") {
      if (editorDirty) await saveCurrent("auto");
      state.noteId = node.dataset.id;
    }
    if (act === "select-open") {
      state.noteId = node.dataset.id;
      switchView("notes");
      return;
    }
    if (act === "new-note" || act === "new-todo") {
      const result = await call("note:create", { note_type: act === "new-todo" ? "todo" : "note" });
      await reload(true);
      state.noteId = result.note.id;
      switchView("notes");
      return;
    }
    if (act === "mode") {
      state.mode = node.dataset.mode;
      editorDirty = false;
    }
    if (act === "save") await saveCurrent("manual");
    if (act === "desk-open") {
      await call("desk:open", { kind: node.dataset.kind, id: node.dataset.id });
      toast("已放到桌面");
    }
    if (act === "open-sticky") {
      await saveCurrent("manual");
      await call("note:save", { id: state.noteId, reason: "manual", fields: { on_desktop: 1 } });
      await call("sticky:open", { id: state.noteId });
      await reload(true);
    }
    if (act === "delete-note" && state.noteId && confirm("删除这张便签？可以在同步前从本机日志里核对。")) {
      await call("note:delete", { id: state.noteId });
      state.noteId = null;
      await reload(true);
    }
    if (act === "color") {
      await call("note:save", { id: state.noteId, reason: "manual", fields: { color: node.dataset.color } });
      await reload(false);
    }
    if (act === "emoji") insertAtCursor(node.dataset.emoji);
    if (act === "add-todo") {
      const input = node.parentElement.querySelector("input");
      const card = node.closest(".card");
      const opener = card && card.querySelector("[data-act='select-open']");
      const noteId = (opener && opener.dataset.id) || state.noteId;
      await call("todo:save", { note_id: noteId, text: input ? input.value : "" });
      await reload(false);
    }
    if (act === "toggle-todo") await call("todo:toggle", { id: node.dataset.id });
    if (act === "delete-todo") await call("todo:delete", { id: node.dataset.id });
    if (act === "delete-reminder") await call("reminder:delete", { id: node.dataset.id });
    if (act === "check-reminders") {
      const result = await call("reminder:check");
      toast(result.fired ? `已提醒 ${result.fired} 条` : "现在没有到期提醒");
    }
    if (act === "add-cat") openCategoryModal();
    if (act === "log-kind") state.logKind = node.dataset.kind;
    if (act === "export-logs") {
      const result = await call("logs:export");
      if (!result.cancelled) toast("日志已导出");
    }
    if (act === "open-logs") await call("folder:logs");
    if (act === "open-data") await call("folder:data");
    if (act === "test-sound") playChime();
    if (act === "save-settings") await saveSettings();
    if (act === "record") recording = node.dataset.action;
    if (act === "login" || act === "register") await submitAuth(act === "register");
    if (act === "sync") {
      const result = await call("sync:now");
      toast(`同步完成，合并 ${result.applied.applied} 条`);
      await reload(false);
    }
    if (act === "logout") {
      await call("sync:logout");
      toast("已退出登录，本地数据仍在");
      await reload(false);
    }
    if (["cat", "select", "mode", "toggle-todo", "delete-todo", "delete-reminder", "log-kind"].includes(act)) {
      if (act === "toggle-todo" || act === "delete-todo" || act === "delete-reminder") await reload(false);
      else render();
    }
  } catch (error) {
    if (!error.soft) toast("操作没有完成");
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    state.query = event.target.value;
    const notes = visibleNotes();
    const html = notes.map((note) => `<button type="button" class="note-item ${note.id === state.noteId ? "active" : ""}" data-act="select" data-id="${note.id}"><i class="swatch" style="background:${note.color}"></i><span><span class="note-title">${escapeHtml(note.title || "未命名")}</span></span></button>`).join("");
    const list = $("list");
    list.querySelectorAll(".note-item, .empty-search").forEach((button) => button.remove());
    list.insertAdjacentHTML("beforeend", html || '<p class="muted empty-search">没有匹配的便签。</p>');
    return;
  }
  if (event.target.id === "title" || event.target.id === "content") scheduleSave();
  if (event.target.id === "opacity") {
    $("opacity-label").textContent = `${event.target.value}%`;
    scheduleSave();
  }
  if (["category", "pinned", "archived", "on-desktop", "pin-desktop", "lock-pos", "on-top", "through"].includes(event.target.id)) scheduleSave();
});

document.body.addEventListener("change", (event) => {
  if (["category", "pinned", "archived", "on-desktop", "pin-desktop", "lock-pos", "on-top", "through", "bg-transparent", "font-family", "font-size", "font-color", "font-bold", "font-italic"].includes(event.target.id)) scheduleSave();
});

document.body.addEventListener("submit", async (event) => {
  if (event.target.id !== "reminder-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await call("reminder:save", {
      title: form.get("title"),
      remind_at: form.get("remind_at"),
      repeat_rule: form.get("repeat_rule"),
      interval_minutes: Number(form.get("interval_minutes") || 0),
      weekdays: form.get("weekdays"),
      note_id: form.get("note_id"),
      sound: form.get("sound") === "on",
      enabled: form.get("enabled") === "on",
    });
    toast("提醒已保存");
    await reload(false);
  } catch (_error) { /* toast already shown */ }
});

document.addEventListener("keydown", (event) => {
  if (recording) {
    event.preventDefault();
    const input = document.querySelector(`.shortcut[data-action="${recording}"]`);
    const combo = shortcutCombo(event);
    if (input && combo && !["ctrl", "alt", "shift", "cmd"].includes(combo)) {
      input.value = combo;
      recording = null;
    }
    return;
  }
  const combo = shortcutCombo(event);
  const found = state.shortcuts.find((item) => item.scope === "app" && item.keys === combo);
  if (!found) return;
  if (["INPUT", "TEXTAREA"].includes(event.target.tagName) && found.action === "search") return;
  event.preventDefault();
  if (found.action === "search") {
    switchView("notes");
    const search = $("search");
    if (search) search.focus();
  }
  if (found.action === "save") saveCurrent("manual").catch(() => {});
  if (found.action === "help") switchView("help");
});

async function saveSettings() {
  await call("settings:save", {
    sound_enabled: $("set-sound").checked,
    close_to_tray: $("set-tray").checked,
    autostart: $("set-start").checked,
    show_main_on_start: $("set-main").checked,
    desktop_limit: Number($("set-limit").value || 8),
    theme: $("set-theme").value,
    auto_sync_minutes: Number($("set-sync-min").value || 0),
    shortcuts: currentShortcuts(),
  });
  toast("设置已保存");
  await reload(false);
}

async function submitAuth(register) {
  const payload = {
    server: $("sync-server").value.trim(),
    username: $("sync-user").value.trim(),
    password: $("sync-pass").value,
  };
  await call(register ? "sync:register" : "sync:login", payload);
  $("sync-pass").value = "";
  toast(register ? "注册并登录成功" : "登录成功");
  await reload(false);
}

function openCategoryModal() {
  const modal = $("modal");
  modal.classList.remove("hidden");
  modal.innerHTML = `<form class="card" id="cat-form"><h2>分类</h2>
    <div class="field"><label>名称</label><input name="name" class="text" required></div>
    <div class="field"><label>颜色</label><input name="color" class="text" value="#0f6e6b"></div>
    <div class="row"><button class="btn" type="submit">保存</button><button type="button" class="btn-quiet" data-act="close-modal">取消</button></div>
    <div class="field">${state.categories.map((item) => `<div class="row between"><span>${escapeHtml(item.name)}</span><button type="button" class="btn-quiet" data-act="delete-cat" data-id="${item.id}">删除</button></div>`).join("")}</div>
  </form>`;
}

document.body.addEventListener("click", async (event) => {
  if (event.target.dataset.act === "close-modal") $("modal").classList.add("hidden");
  if (event.target.dataset.act === "delete-cat") {
    await call("category:delete", { id: event.target.dataset.id });
    await reload(false);
    openCategoryModal();
  }
});

document.body.addEventListener("submit", async (event) => {
  if (event.target.id !== "cat-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  await call("category:save", { name: form.get("name"), color: form.get("color") });
  $("modal").classList.add("hidden");
  await reload(false);
});

document.body.addEventListener("click", (event) => {
  const link = event.target.closest("#view-help a, #preview a");
  if (!link) return;
  event.preventDefault();
  window.desknote.invoke("link:open", { url: link.getAttribute("href") });
});

window.DeskNote = {
  async onExternalChange() {
    if (editorDirty) return;
    await reload(false);
  },
};

window.addEventListener("DOMContentLoaded", async () => {
  window.desknote.on("data:changed", () => window.DeskNote.onExternalChange());
  const data = await call("bootstrap");
  applyData(data);
  if (state.notes[0]) state.noteId = state.notes[0].id;
  render();
});
