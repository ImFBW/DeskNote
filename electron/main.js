"use strict";

const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, shell, dialog, screen,
} = require("electron");
const { DesktopDb } = require("./db");
const { Logger } = require("./logger");
const { requestJson } = require("./sync");
const { applyWindowMode, isAdjusting, platformError, reassertPin, screenBoundsDip } = require("./platform");
const {
  RuleError, normalizeShortcuts, parseIso, utcnowIso, validPassword, validUsername,
} = require("../shared/logic");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess,CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
app.setName("DeskNote");

const smoke = process.argv.includes("--smoke");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (smoke) {
    console.error("SMOKE_LOCK");
    process.exit(1);
  }
  app.quit();
}

let db;
let logger;
let tray = null;
let mainWindow = null;
let bubbleWindow = null;
let dock = null;
let adminServers = [];
let adminUrl = "http://127.0.0.1:8787";
const cards = new Map();
let quitting = false;
let lastKey = "";
let syncing = false;
const root = path.join(__dirname, "..");
const renderer = path.join(root, "renderer");

function dataDir() {
  if (process.env.DESKNOTE_DATA) return process.env.DESKNOTE_DATA;
  return app.getPath("userData");
}

function tuneFrameRate(win) {
  const setRate = (fps) => {
    if (typeof win.webContents.setFrameRate === "function") win.webContents.setFrameRate(fps);
  };
  win.on("focus", () => setRate(30));
  win.on("blur", () => setRate(4));
  setRate(30);
}

function harden(win) {
  win.webContents.setBackgroundThrottling(true);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  tuneFrameRate(win);
}

function createMain() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#efeae0",
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  harden(win);
  win.once("ready-to-show", () => {
    if (!smoke && db.getSetting("show_main_on_start") === "1") win.show();
  });
  win.on("close", (event) => {
    if (quitting || smoke) return;
    if (db.getSetting("close_to_tray") !== "0") {
      event.preventDefault();
      win.hide();
      logger.operation("window.hide_to_tray");
    }
  });
  win.loadFile(path.join(renderer, "index.html"));
  mainWindow = win;
  return win;
}

function webPrefs() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    backgroundThrottling: true,
    devTools: process.env.DESKNOTE_DEV === "1",
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("data:changed");
  if (dock && !dock.isDestroyed()) dock.webContents.send("data:changed");
  cards.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send("data:changed");
  });
}

function tableOf(kind) {
  if (kind === "note") return "notes";
  if (kind === "todo") return "todos";
  if (kind === "reminder") return "reminders";
  throw new RuleError("类型不正确");
}

function cardKey(kind, id) { return `${kind}:${id}`; }

function openCard(kind, id, focus = true) {
  const table = tableOf(kind);
  let item = db.getItem(table, id);
  if (!item || item.deleted) throw new RuleError("内容不存在");
  if (!item.on_desktop) item = db.updateSurface(table, id, { on_desktop: 1 });
  const key = cardKey(kind, id);
  const existing = cards.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    if (focus) existing.focus();
    applyWindowMode(existing, item);
    lastKey = key;
    return { kind, id };
  }
  const area = screen.getPrimaryDisplay().workArea;
  const offset = (cards.size % 5) * 26;
  const win = new BrowserWindow({
    width: item.width || (kind === "reminder" ? 320 : 300),
    height: item.height || (kind === "note" ? 360 : kind === "reminder" ? 260 : 150),
    x: Number.isInteger(item.pos_x) ? item.pos_x : area.x + 32 + offset,
    y: Number.isInteger(item.pos_y) ? item.pos_y : area.y + 72 + offset,
    minWidth: 220,
    minHeight: 120,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    thickFrame: false,
    show: false,
    skipTaskbar: true,
    webPreferences: webPrefs(),
  });
  harden(win);
  cards.set(key, win);
  lastKey = key;
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || isAdjusting(win)) return;
      const current = db.getItem(table, id);
      if (current && current.position_locked) return;
      const bounds = screenBoundsDip(win);
      try {
        db.updateSurface(table, id, { pos_x: bounds.x, pos_y: bounds.y, width: bounds.width, height: bounds.height }, { touch: false });
      } catch (_error) { /* 已删除 */ }
    }, 400);
  };
  win.on("move", saveBounds);
  win.on("resize", saveBounds);
  win.on("close", () => {
    if (!quitting) {
      try { db.updateSurface(table, id, { on_desktop: 0 }, { touch: false }); } catch (_error) { /* 已删除 */ }
      logger.operation("desk.close", key);
    }
    cards.delete(key);
    if (!quitting) broadcast();
  });
  win.once("ready-to-show", () => {
    win.showInactive();
    const fresh = db.getItem(table, id);
    if (fresh) applyWindowMode(win, fresh);
    if (focus && fresh && !fresh.click_through) win.focus();
  });
  win.loadFile(path.join(renderer, "desk.html"), { query: { kind, id } });
  logger.operation("desk.open", key);
  return { kind, id };
}

function syncCard(kind, item, fields) {
  if (!item) return;
  const win = cards.get(cardKey(kind, item.id));
  const modeKeys = ["opacity", "always_on_top", "click_through", "pin_desktop", "on_desktop", "position_locked"];
  if (!item.on_desktop && win) closeCard(kind, item.id);
  else if (win && !win.isDestroyed() && (!fields || modeKeys.some((key) => key in fields))) applyWindowMode(win, item);
  broadcast();
}

function closeCard(kind, id) {
  const key = cardKey(kind, id);
  const win = cards.get(key);
  if (win && !win.isDestroyed()) win.close();
  else {
    try { db.updateSurface(tableOf(kind), id, { on_desktop: 0 }, { touch: false }); } catch (_error) { /* 已删除 */ }
  }
}

function openDock() {
  if (dock && !dock.isDestroyed()) {
    dock.show();
    dock.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  dock = new BrowserWindow({
    width: 220,
    height: 360,
    x: area.x + area.width - 240,
    y: area.y + 16,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#fffdf8",
    webPreferences: webPrefs(),
  });
  harden(dock);
  dock.setAlwaysOnTop(true, "floating");
  dock.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    dock.hide();
  });
  dock.once("ready-to-show", () => dock.show());
  dock.loadFile(path.join(renderer, "dock.html"));
}

async function startAdmin() {
  const { listenLocal } = require("../server/server");
  const projectData = path.join(root, "server", "data");
  if (!process.env.DESKNOTE_SERVER_DATA) {
    process.env.DESKNOTE_SERVER_DATA = fs.existsSync(path.join(projectData, "server.sqlite"))
      ? projectData
      : path.join(dataDir(), "server");
  }
  const port = Number(process.env.DESKNOTE_PORT || 8787);
  adminUrl = `http://127.0.0.1:${port}`;
  try {
    const started = await listenLocal(port);
    adminServers = started.servers;
    adminUrl = `http://127.0.0.1:${started.port}`;
    logger.operation("admin.listen", adminUrl);
  } catch (error) {
    if (error.code === "EADDRINUSE") logger.operation("admin.listen", "8787 已有服务");
    else logger.error("admin.listen", error);
  }
}

function showBubble(title, body, noteId, withSound) {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.close();
  const area = screen.getPrimaryDisplay().workArea;
  const width = 360;
  const height = 138;
  bubbleWindow = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width - 16,
    y: area.y + area.height - height - 16,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#fffdf8",
    webPreferences: webPrefs(),
  });
  harden(bubbleWindow);
  bubbleWindow.setAlwaysOnTop(true, "floating");
  bubbleWindow.once("ready-to-show", () => bubbleWindow.showInactive());
  bubbleWindow.on("closed", () => { bubbleWindow = null; });
  bubbleWindow.loadFile(path.join(renderer, "bubble.html"), {
    query: { title, body, noteId: noteId || "", sound: withSound ? "1" : "0" },
  });
}

function processDue() {
  const now = utcnowIso();
  const due = db.dueReminders(now);
  let fired = 0;
  due.forEach((reminder) => {
    const late = Date.now() - parseIso(reminder.next_fire_at).getTime();
    if (late > 12 * 3600 * 1000) {
      db.settleReminder(reminder.id, false);
      logger.operation("reminder.skip_stale", reminder.title);
      return;
    }
    db.settleReminder(reminder.id, true);
    logger.operation("reminder.fire", reminder.title);
    fired += 1;
    const soundOn = db.getSetting("sound_enabled") !== "0" && reminder.sound;
    showBubble(reminder.title, "到达设定时间", reminder.note_id || "", soundOn);
  });
  if (fired) broadcast();
  return fired;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  let shortcuts = [];
  try {
    shortcuts = normalizeShortcuts(db.shortcuts());
  } catch (error) {
    logger.error("hotkey.parse", error);
    return;
  }
  shortcuts.filter((item) => item.scope === "global").forEach((item) => {
    try {
      const ok = globalShortcut.register(item.binding, () => handleAction(item.action));
      if (!ok) logger.operation("hotkey.bind", `${item.keys} 注册失败`, false);
    } catch (error) {
      logger.error("hotkey.bind", error);
    }
  });
}

function handleAction(action) {
  try {
    if (action === "new_note" || action === "new_todo" || action === "new_reminder") {
      const kind = action === "new_note" ? "note" : action === "new_todo" ? "todo" : "reminder";
      const created = db.createDesktop(kind);
      openCard(kind, created.id, true);
      broadcast();
      return;
    }
    if (action === "toggle_main") {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
      return;
    }
    if (action === "toggle_clickthrough") {
      const key = lastKey || [...cards.keys()].at(-1);
      if (!key) return;
      const [kind, id] = key.split(":");
      const item = db.getItem(tableOf(kind), id);
      if (!item) return;
      const next = item.click_through ? 0 : 1;
      const saved = db.updateSurface(tableOf(kind), id, { click_through: next });
      const win = cards.get(key);
      if (win) applyWindowMode(win, saved);
      logger.operation("window.clickthrough", `${key} ${next ? "on" : "off"}`);
      showBubble(next ? "已开启鼠标穿透" : "已关闭鼠标穿透", next ? "按 Ctrl+Alt+P 可以关掉" : "现在可以点击这张卡片", kind === "note" ? id : "", false);
      broadcast();
      return;
    }
    if (action === "sync_now") syncNow().catch((error) => logger.error("sync.now", error));
  } catch (error) {
    logger.error(`hotkey.${action}`, error);
  }
}

async function syncNow() {
  const token = db.getSetting("sync_token") || "";
  const server = db.getSetting("sync_server") || "";
  if (!token || !server) throw new RuleError("本地可以继续使用。同步到服务器前需要先登录。");
  if (syncing) throw new RuleError("同步正在进行");
  syncing = true;
  try {
    const since = db.getSetting("last_sync_at") || "";
    const outgoing = db.exportSince(since);
    const incoming = await requestJson(server, `/api/v1/sync/pull?since=${encodeURIComponent(since)}`, { token });
    const applied = db.applyBundle(incoming);
    const pushed = await requestJson(server, "/api/v1/sync/push", { method: "POST", token, body: outgoing });
    db.setSetting("last_sync_at", pushed.server_time || utcnowIso());
    broadcast();
    logger.operation("sync.now", `applied ${applied.applied}`);
    return { applied, pushed: pushed.applied || {}, server_time: db.getSetting("last_sync_at") };
  } catch (error) {
    if (error.status === 401) db.setSetting("sync_token", "");
    throw error;
  } finally {
    syncing = false;
  }
}

function storeSession(server, payload, username) {
  const token = payload.token || "";
  if (!token) throw new RuleError("服务器没有返回登录令牌");
  db.setSetting("sync_server", server);
  db.setSetting("sync_token", token);
  db.setSetting("sync_username", (payload.user && payload.user.username) || username);
  return { username: db.getSetting("sync_username"), server };
}

function brief(payload) {
  if (!payload || typeof payload !== "object") return "";
  const copy = { ...payload };
  delete copy.password;
  delete copy.token;
  if (copy.fields && copy.fields.content) copy.fields = { ...copy.fields, content: `[${copy.fields.content.length} chars]` };
  return JSON.stringify(copy).slice(0, 500);
}

function handle(channel, fn, { persist = true, quiet = false } = {}) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const result = await fn(payload || {});
      if (!quiet) logger.operation(channel, brief(payload), true, persist);
      const data = result && typeof result === "object" ? result : {};
      return { ok: true, ...data };
    } catch (error) {
      if (error instanceof RuleError || error.expose) {
        logger.operation(channel, error.message, false);
        return { ok: false, error: error.message };
      }
      logger.error(channel, error);
      return { ok: false, error: "操作失败，详情已经写入错误日志" };
    }
  });
}

function registerIpc() {
  handle("bootstrap", () => ({ ...db.snapshot(), version: "1.0.0" }), { quiet: true });
  handle("note:create", (payload) => ({ note: db.createNote(payload.note_type || "note") }));
  handle("note:save", (payload) => {
    const reason = payload.reason || "manual";
    const note = db.updateNote(payload.id, payload.fields || {});
    logger.operation("note.save", payload.id, true, reason !== "auto" || logger.allowAuto(payload.id));
    const modeKeys = ["opacity", "always_on_top", "click_through", "pin_desktop", "on_desktop", "position_locked"];
    const win = cards.get(cardKey("note", payload.id));
    if (win && "on_desktop" in (payload.fields || {}) && !note.on_desktop) closeCard("note", payload.id);
    else if (win && !win.isDestroyed() && modeKeys.some((key) => key in (payload.fields || {}))) applyWindowMode(win, note);
    if ((payload.reason || "manual") !== "auto") broadcast();
    return { note };
  }, { quiet: true });
  handle("note:delete", (payload) => {
    closeCard("note", payload.id);
    db.deleteNote(payload.id);
    broadcast();
    return { id: payload.id };
  });
  handle("category:save", (payload) => ({ category: db.saveCategory(payload) }));
  handle("category:delete", (payload) => {
    db.deleteCategory(payload.id);
    return { id: payload.id };
  });
  handle("todo:save", (payload) => {
    const todo = db.saveTodo(payload);
    syncCard("todo", todo, payload);
    return { todo };
  });
  handle("todo:toggle", (payload) => {
    const todo = db.toggleTodo(payload.id);
    broadcast();
    return { todo };
  });
  handle("todo:delete", (payload) => {
    closeCard("todo", payload.id);
    db.deleteTodo(payload.id);
    broadcast();
    return { id: payload.id };
  });
  handle("reminder:save", (payload) => {
    const reminder = db.saveReminder(payload);
    syncCard("reminder", reminder, payload);
    return { reminder };
  });
  handle("reminder:delete", (payload) => {
    closeCard("reminder", payload.id);
    db.deleteReminder(payload.id);
    broadcast();
    return { id: payload.id };
  });
  handle("reminder:check", () => ({ fired: processDue() }));
  handle("settings:save", (payload) => applySettings(payload));
  handle("sound:test", () => ({ played: true }), { quiet: true });
  handle("sync:register", async (payload) => {
    if (!validUsername(payload.username) || !validPassword(payload.password)) {
      throw new RuleError("用户名 3-32 位字母数字，密码至少 6 位");
    }
    const server = payload.server;
    const result = await requestJson(server, "/api/v1/auth/register", {
      method: "POST",
      body: { username: payload.username, password: payload.password, display_name: payload.display_name || "" },
    });
    return storeSession(server, result, payload.username);
  });
  handle("sync:login", async (payload) => {
    const result = await requestJson(payload.server, "/api/v1/auth/login", {
      method: "POST",
      body: { username: payload.username, password: payload.password },
    });
    return storeSession(payload.server, result, payload.username);
  });
  handle("sync:logout", async () => {
    const token = db.getSetting("sync_token") || "";
    const server = db.getSetting("sync_server") || "";
    if (token && server) {
      try { await requestJson(server, "/api/v1/auth/logout", { method: "POST", token, body: {} }); } catch (_error) { /* 本地仍退出 */ }
    }
    db.setSetting("sync_token", "");
    db.setSetting("sync_username", "");
    return { logged_in: false };
  });
  handle("sync:now", () => syncNow(), { quiet: true });
  handle("logs:list", (payload) => ({
    logs: db.listLogs(payload.kind || "op", payload.limit || 200, payload.query || ""),
  }), { quiet: true });
  handle("logs:export", async () => {
    const chosen = await dialog.showSaveDialog(mainWindow, {
      defaultPath: "desknote-logs.txt",
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const ops = db.listLogs("op", 1000);
    const errors = db.listLogs("error", 1000);
    const lines = ["# 操作日志"];
    ops.slice().reverse().forEach((row) => lines.push(`${row.ts}\t${row.ok ? "OK" : "FAIL"}\t${row.action}\t${row.detail || ""}`));
    lines.push("", "# 错误日志");
    errors.slice().reverse().forEach((row) => {
      lines.push(`${row.ts}\t${row.source}\t${row.message}`);
      if (row.traceback) lines.push(row.traceback);
    });
    fs.writeFileSync(chosen.filePath, lines.join("\n"), "utf8");
    return { path: chosen.filePath };
  });
  handle("folder:data", () => {
    shell.openPath(dataDir());
    return { path: dataDir() };
  });
  handle("folder:logs", () => {
    const dir = path.join(dataDir(), "logs");
    shell.openPath(dir);
    return { path: dir };
  });
  handle("help:manual", () => {
    const file = path.join(root, "docs", "使用说明书.md");
    return { markdown: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "还没有找到使用说明书。" };
  }, { quiet: true });
  handle("sticky:open", (payload) => openCard("note", payload.id, true));
  handle("sticky:state", (payload) => {
    const note = db.getNote(payload.id);
    if (!note || note.deleted) throw new RuleError("便签不存在");
    lastKey = cardKey("note", payload.id);
    return { note, todos: db.listTodos(payload.id) };
  }, { quiet: true });
  handle("sticky:close", (payload) => {
    closeCard("note", payload.id);
    return { id: payload.id };
  });
  handle("desk:create", (payload) => {
    const created = db.createDesktop(payload.kind);
    db.updateSurface(tableOf(payload.kind), created.id, { pin_desktop: 1 });
    const opened = openCard(payload.kind, created.id, true);
    broadcast();
    return opened;
  });
  handle("desk:open", (payload) => {
    const opened = openCard(payload.kind, payload.id, true);
    broadcast();
    return opened;
  });
  handle("desk:state", (payload) => {
    const item = db.getItem(tableOf(payload.kind), payload.id);
    if (!item || item.deleted) throw new RuleError("内容不存在");
    lastKey = cardKey(payload.kind, payload.id);
    return { kind: payload.kind, item };
  }, { quiet: true });
  handle("desk:close", (payload) => {
    closeCard(payload.kind, payload.id);
    return { id: payload.id };
  });
  handle("desk:delete", (payload) => {
    closeCard(payload.kind, payload.id);
    if (payload.kind === "note") db.deleteNote(payload.id);
    if (payload.kind === "todo") db.deleteTodo(payload.id);
    if (payload.kind === "reminder") db.deleteReminder(payload.id);
    broadcast();
    return { id: payload.id };
  });
  handle("desk:limit", (payload) => ({ limit: db.setDesktopLimit(payload.limit) }));
  handle("dock:state", () => ({ limit: db.desktopLimit(), count: db.desktopCount(), admin_url: adminUrl }), { quiet: true });
  handle("through:clear", () => {
    db.clearClickThrough();
    cards.forEach((win, key) => {
      const [kind, id] = key.split(":");
      const item = db.getItem(tableOf(kind), id);
      if (item && win && !win.isDestroyed()) applyWindowMode(win, item);
    });
    broadcast();
    return {};
  });
  handle("admin:open", () => {
    shell.openExternal(adminUrl);
    return { url: adminUrl };
  });
  handle("main:show", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return {};
  });
  handle("bubble:open", (payload) => {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.close();
    if (payload.noteId) openCard("note", payload.noteId, true);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return {};
  });
  handle("link:open", (payload) => {
    const url = String(payload.url || "");
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) throw new RuleError("只打开 http、https 或邮件链接");
    shell.openExternal(url);
    return {};
  });
}

function applySettings(payload) {
  const messages = [];
  if ("sound_enabled" in payload) db.setSetting("sound_enabled", payload.sound_enabled ? "1" : "0");
  if ("close_to_tray" in payload) db.setSetting("close_to_tray", payload.close_to_tray ? "1" : "0");
  if ("theme" in payload) db.setSetting("theme", payload.theme === "ink" ? "ink" : "paper");
  if ("auto_sync_minutes" in payload) {
    const minutes = Math.max(0, Math.min(Number(payload.auto_sync_minutes) || 0, 1440));
    db.setSetting("auto_sync_minutes", String(minutes));
  }
  if ("shortcuts" in payload) {
    const normalized = normalizeShortcuts(payload.shortcuts);
    db.setSetting("shortcuts", JSON.stringify(normalized.map(({ action, keys, scope, label }) => ({ action, keys, scope, label }))));
    registerShortcuts();
  }
  if ("show_main_on_start" in payload) db.setSetting("show_main_on_start", payload.show_main_on_start ? "1" : "0");
  if ("desktop_limit" in payload) db.setDesktopLimit(payload.desktop_limit);
  if ("autostart" in payload) {
    app.setLoginItemSettings({
      openAtLogin: Boolean(payload.autostart),
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(root)],
    });
    db.setSetting("autostart", payload.autostart ? "1" : "0");
    messages.push(payload.autostart ? "已设置开机启动" : "已取消开机启动");
  }
  return { settings: db.publicSettings(), shortcuts: db.shortcuts(), message: messages.join("；") };
}

function createTray() {
  const iconPath = path.join(root, "assets", "icon.png");
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAHElEQVQ4T2NkoBAwUqifAYyMjP8ZGP7//8+ABQYA4x0H9d0m2dQAAAAASUVORK5CYII=") : image.resize({ width: 16, height: 16 }));
  tray.setToolTip("DeskNote");
  const menu = Menu.buildFromTemplate([
    { label: "显示桌面条", click: () => openDock() },
    { label: "显示主窗口", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: "新建便签", click: () => handleAction("new_note") },
    { label: "新建待办", click: () => handleAction("new_todo") },
    { label: "新建提醒", click: () => handleAction("new_reminder") },
    { label: "打开后台", click: () => shell.openExternal(adminUrl) },
    { label: "立即同步", click: () => handleAction("sync_now") },
    { label: "关闭鼠标穿透", click: () => {
      db.clearClickThrough();
      cards.forEach((win, key) => {
        const [kind, id] = key.split(":");
        const item = db.getItem(tableOf(kind), id);
        if (item && !win.isDestroyed()) applyWindowMode(win, item);
      });
      broadcast();
    } },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => openDock());
}

function boot() {
  fs.mkdirSync(dataDir(), { recursive: true });
  db = new DesktopDb(path.join(dataDir(), "desknote.sqlite"));
  db.init();
  logger = new Logger(db, path.join(dataDir(), "logs"));
  logger.operation("app.start", `electron ${process.versions.electron}`);
  if (platformError()) logger.error("platform.load", new Error(platformError()));
  if (!smoke) startAdmin().catch((error) => logger.error("admin.listen", error));
  registerIpc();
  createMain();
  if (!smoke) {
    registerShortcuts();
    createTray();
    openDock();
    db.desktopNotes().forEach((note) => {
      try { openCard("note", note.id, false); } catch (error) { logger.error("desk.restore", error); }
    });
    db.desktopTodos().forEach((todo) => {
      try { openCard("todo", todo.id, false); } catch (error) { logger.error("desk.restore", error); }
    });
    db.desktopReminders().forEach((reminder) => {
      try { openCard("reminder", reminder.id, false); } catch (error) { logger.error("desk.restore", error); }
    });
  }
  const reminderTimer = setInterval(() => {
    try { processDue(); } catch (error) { logger.error("reminder.loop", error); }
  }, 15000);
  const syncTimer = setInterval(() => {
    const minutes = Number(db.getSetting("auto_sync_minutes") || 0);
    if (!minutes || !db.getSetting("sync_token")) return;
    const last = Date.parse(db.getSetting("last_sync_at") || 0) || 0;
    if (Date.now() - last < minutes * 60000) return;
    syncNow().catch((error) => logger.error("sync.auto", error));
  }, 60000);
  const pinTimer = setInterval(() => {
    cards.forEach((win, key) => {
      const [kind, id] = key.split(":");
      const item = db.getItem(tableOf(kind), id);
      if (item && item.pin_desktop && !win.isDestroyed()) {
        try { reassertPin(win); } catch (error) { logger.error("window.pin_refresh", error); }
      }
    });
  }, 5000);
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(reminderTimer);
    clearInterval(syncTimer);
    clearInterval(pinTimer);
    globalShortcut.unregisterAll();
    adminServers.forEach((server) => server.close());
    logger.operation("app.quit");
  });
}

if (gotLock) {
  app.on("second-instance", () => {
    if (dock) openDock();
    else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    boot();
    if (smoke) {
      const timer = setTimeout(() => {
        console.error("SMOKE_TIMEOUT");
        app.exit(1);
      }, 20000);
      mainWindow.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        const notes = db.listNotes();
        if (!notes.length) {
          console.error("SMOKE_FAIL");
          app.exit(1);
          return;
        }
        console.log("SMOKE_OK");
        app.exit(0);
      });
    }
  });
  app.on("window-all-closed", () => {});
}

process.on("uncaughtException", (error) => {
  if (logger) logger.error("uncaughtException", error);
});
process.on("unhandledRejection", (error) => {
  if (logger) logger.error("unhandledRejection", error);
});
