"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const logic = require("../shared/logic");
const { DesktopDb } = require("../electron/db");
const { listenLocal } = require("../server/server");

function iso(date) { return logic.toIso(date); }

function testLogic() {
  const hash = logic.hashPassword("secret-1");
  assert.strictEqual(logic.verifyPassword("secret-1", hash), true);
  assert.strictEqual(logic.verifyPassword("nope", hash), false);
  const now = new Date("2026-11-06T02:00:00Z");
  const morning = new Date("2026-11-06T01:30:00Z");
  const daily = logic.nextOccurrence(morning, "daily", 0, "", now, 0);
  assert.strictEqual(iso(daily), "2026-11-07T01:30:00Z");
  const weekly = logic.nextOccurrence(new Date("2026-11-02T01:00:00Z"), "weekly", 0, "0", now, 0);
  assert.ok(weekly > now);
  const monthly = logic.nextOccurrence(new Date("2026-01-31T01:00:00Z"), "monthly", 0, "", new Date("2026-02-01T00:00:00Z"), 0);
  assert.strictEqual(monthly.getUTCDate(), 28);
  const interval = logic.nextOccurrence(new Date("2026-11-06T00:00:00Z"), "interval", 30, "", new Date("2026-11-06T01:10:00Z"), 0);
  assert.strictEqual(iso(interval), "2026-11-06T01:30:00Z");
  assert.strictEqual(logic.nextOccurrence(new Date("2026-11-01T00:00:00Z"), "none", 0, "", now, 0), null);
  assert.throws(() => logic.normalizeShortcuts([
    { action: "new_note", keys: "ctrl+alt+n", scope: "global" },
    { action: "new_todo", keys: "ctrl+alt+n", scope: "global" },
  ]), /冲突/);
  assert.strictEqual(logic.remoteShouldReplace("2026-11-06T00:00:00Z", "2026-11-06T00:00:01Z"), true);
  assert.strictEqual(logic.remoteShouldReplace("2026-11-06T00:00:02Z", "2026-11-06T00:00:01Z"), false);
  logic.parseHotkey("ctrl+alt+n");
  logic.parseHotkey("f1");
}

function testDb(dir) {
  const db = new DesktopDb(path.join(dir, "desknote.sqlite"));
  db.init();
  assert.ok(db.listNotes().length >= 2);
  const note = db.createNote("note");
  const saved = db.updateNote(note.id, {
    title: "测试", content: "正文 **粗**", color: "#fff4c8", bg_transparent: 1, font_family: "Consolas", font_size: 18, font_bold: 1,
  });
  assert.strictEqual(saved.title, "测试");
  assert.strictEqual(saved.bg_transparent, 1);
  assert.strictEqual(saved.font_family, "Consolas");
  db.setDesktopLimit(1);
  db.updateNote(note.id, { on_desktop: 1 });
  assert.throws(() => db.updateNote(db.createNote("note").id, { on_desktop: 1 }), /最多放 1 个/);
  const todo = db.saveTodo({ note_id: note.id, text: "买牛奶" });
  const toggled = db.toggleTodo(todo.id);
  assert.strictEqual(toggled.done, 1);
  const past = new Date(Date.now() - 60000);
  const reminder = db.saveReminder({
    title: "马上", note_id: note.id, remind_at: past.toISOString(), repeat_rule: "none", enabled: 1, sound: 0,
  });
  const due = db.dueReminders(logic.utcnowIso());
  assert.ok(due.some((item) => item.id === reminder.id));
  const settled = db.settleReminder(reminder.id, true);
  assert.strictEqual(settled.enabled, 0);
  db.deleteNote(note.id);
  assert.strictEqual(db.getNote(note.id).deleted, 1);
  const remote = db.getNote(db.listNotes(true)[0].id);
  const older = { ...remote, title: "旧", updated_at: "2000-01-01T00:00:00Z" };
  const stats = db.applyBundle({ notes: [older] });
  assert.ok(stats.kept >= 1);
  db.addOpLog(logic.utcnowIso(), "selftest", "ok", true);
  db.addErrorLog(logic.utcnowIso(), "selftest", "boom", "stack");
  assert.ok(db.listLogs("op", 10, "selftest").length >= 1);
}

function request(port, method, route, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: "127.0.0.1", port, path: route, method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = {};
        if (text.startsWith("{") || text.startsWith("[")) body = JSON.parse(text);
        else body = { html: text };
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function testServer(dir) {
  process.env.DESKNOTE_SERVER_DATA = dir;
  process.env.DESKNOTE_ADMIN_USER = "admin";
  process.env.DESKNOTE_ADMIN_PASSWORD = "admin-pass-1";
  const started = await listenLocal(0);
  const port = started.port;
  try {
    const local = await requestHost("localhost", port, "GET", "/api/health");
    assert.strictEqual(local.body.ok, true);
    const health = await request(port, "GET", "/api/health");
    assert.strictEqual(health.body.ok, true);
    const registered = await request(port, "POST", "/api/v1/auth/register", {
      body: { username: "alice", password: "alice-pass", display_name: "Alice" },
    });
    assert.strictEqual(registered.status, 200, JSON.stringify(registered.body));
    const pushed = await request(port, "POST", "/api/v1/sync/push", {
      token: registered.body.token,
      body: { device_id: "dev", notes: [{
        id: "note1", title: "同步标题", content: "hello", note_type: "note", color: "#fffdf8",
        pinned: 0, archived: 0, on_desktop: 0, pin_desktop: 0, always_on_top: 0, click_through: 0,
        opacity: 1, width: 320, height: 280, created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z", deleted: 0,
      }] },
    });
    assert.strictEqual(pushed.body.applied.notes, 1);
    const pulled = await request(port, "GET", "/api/v1/sync/pull?since=", { token: registered.body.token });
    assert.ok(pulled.body.notes.some((note) => note.title === "同步标题"));
    const admin = await request(port, "POST", "/api/admin/login", { body: { username: "admin", password: "admin-pass-1" } });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.body));
    const overview = await request(port, "GET", "/api/admin/overview", { token: admin.body.token });
    assert.ok(overview.body.users >= 2);
    const page = await request(port, "GET", "/");
    assert.strictEqual(page.status, 200);
    const user = overview.body && (await request(port, "GET", "/api/admin/users", { token: admin.body.token })).body.users.find((item) => item.username === "alice");
    const disabled = await request(port, "POST", `/api/admin/users/${user.id}/disable`, { token: admin.body.token, body: { disabled: true } });
    assert.strictEqual(disabled.body.ok, true);
    const denied = await request(port, "POST", "/api/v1/sync/push", { token: registered.body.token, body: { notes: [] } });
    assert.strictEqual(denied.status, 401);
    const bad = await request(port, "POST", "/api/v1/auth/login", { body: { username: "alice", password: "wrong-pass" } });
    assert.strictEqual(bad.status, 401);
  } finally {
    await Promise.all(started.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function requestHost(hostname, port, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  testLogic();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desknote-test-"));
  testDb(dir);
  await testServer(path.join(dir, "server"));
  console.log("SELFTEST_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
