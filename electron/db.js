"use strict";

const {
  DEFAULT_SHORTCUTS,
  NOTE_TYPES,
  REPEAT_RULES,
  RuleError,
  advanceAfterFire,
  initialNextFire,
  localOffsetMinutes,
  newId,
  parseIso,
  remoteShouldReplace,
  toIso,
  utcnowIso,
} = require("../shared/logic");
const { ensureColumns, openDatabase, plain, rows, SURFACE_COLUMNS } = require("../shared/sqlite");

const FONTS = new Set(["", "Microsoft YaHei", "SimSun", "KaiTi", "Segoe UI", "Consolas", "Georgia"]);
const STYLE_ONLY = SURFACE_COLUMNS.filter(([name]) => name.startsWith("font_") || name === "bg_transparent");

const NOTE_COLUMNS = [
  "id", "category_id", "title", "content", "note_type", "color", "pinned", "archived",
  "on_desktop", "pin_desktop", "always_on_top", "click_through", "opacity", "pos_x", "pos_y",
  "width", "height", "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic",
  "created_at", "updated_at", "deleted",
];
const CATEGORY_COLUMNS = ["id", "name", "color", "sort_order", "created_at", "updated_at", "deleted"];
const TODO_COLUMNS = [
  "id", "note_id", "text", "done", "sort_order", "due_at", "on_desktop", "pin_desktop", "always_on_top",
  "click_through", "opacity", "pos_x", "pos_y", "width", "height", "color", "bg_transparent", "font_family",
  "font_size", "font_color", "font_bold", "font_italic", "created_at", "updated_at", "deleted",
];
const REMINDER_COLUMNS = [
  "id", "note_id", "title", "remind_at", "tz_offset_minutes", "repeat_rule", "interval_minutes",
  "weekdays", "sound", "enabled", "last_fired_at", "next_fire_at", "on_desktop", "pin_desktop",
  "always_on_top", "click_through", "opacity", "pos_x", "pos_y", "width", "height", "color",
  "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic",
  "created_at", "updated_at", "deleted",
];

function flag(value) {
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) ? 1 : 0;
  return value ? 1 : 0;
}

class DesktopDb {
  constructor(file) {
    this.file = file;
    this.db = openDatabase(file);
  }

  init() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, category_id TEXT, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
        note_type TEXT NOT NULL DEFAULT 'note', color TEXT NOT NULL DEFAULT '#fffdf8',
        pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        on_desktop INTEGER NOT NULL DEFAULT 0, pin_desktop INTEGER NOT NULL DEFAULT 0,
        always_on_top INTEGER NOT NULL DEFAULT 0, click_through INTEGER NOT NULL DEFAULT 0,
        opacity REAL NOT NULL DEFAULT 1, pos_x INTEGER, pos_y INTEGER,
        width INTEGER NOT NULL DEFAULT 320, height INTEGER NOT NULL DEFAULT 280,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY, note_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, due_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, note_id TEXT, title TEXT NOT NULL, remind_at TEXT NOT NULL,
        tz_offset_minutes INTEGER NOT NULL DEFAULT 0, repeat_rule TEXT NOT NULL DEFAULT 'none',
        interval_minutes INTEGER NOT NULL DEFAULT 0, weekdays TEXT NOT NULL DEFAULT '',
        sound INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT, next_fire_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS op_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT, ok INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL,
        message TEXT NOT NULL, traceback TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_todos_note ON todos(note_id)`,
      `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(enabled, next_fire_at)`,
    ];
    statements.forEach((sql) => this.db.exec(sql));
    const lockColumn = [["position_locked", "INTEGER NOT NULL DEFAULT 0"]];
    ensureColumns(this.db, "notes", STYLE_ONLY.concat(lockColumn));
    ensureColumns(this.db, "todos", SURFACE_COLUMNS.concat(lockColumn));
    ensureColumns(this.db, "reminders", SURFACE_COLUMNS.concat(lockColumn));
    this.db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO NOTHING").run();
    this.ensureSettings();
    this.seed();
  }

  ensureSettings() {
    const defaults = {
      shortcuts: JSON.stringify(DEFAULT_SHORTCUTS),
      device_id: newId(),
      sound_enabled: "1",
      close_to_tray: "1",
      autostart: "0",
      auto_sync_minutes: "0",
      theme: "paper",
      sync_server: "",
      sync_token: "",
      sync_username: "",
      last_sync_at: "",
      desktop_limit: "8",
      show_main_on_start: "0",
    };
    Object.entries(defaults).forEach(([key, value]) => {
      if (this.getSetting(key) == null) this.setSetting(key, value);
    });
  }

  seed() {
    if (this.getMeta("seeded") === "1") return;
    if (this.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n) {
      this.setMeta("seeded", "1");
      return;
    }
    const now = utcnowIso();
    const work = newId();
    const life = newId();
    const idea = newId();
    const insertCategory = this.db.prepare(
      "INSERT INTO categories(id, name, color, sort_order, created_at, updated_at, deleted) VALUES(?, ?, ?, ?, ?, ?, 0)"
    );
    [["工作", "#0f6e6b", work], ["生活", "#c46b3a", life], ["灵感", "#6b5b95", idea]].forEach((item, index) => {
      insertCategory.run(item[2], item[0], item[1], index, now, now);
    });
    const noteId = newId();
    const welcome = [
      "# 欢迎使用 DeskNote",
      "",
      "这张便签保存在本机 SQLite 里，**不登录也能用**。",
      "",
      "## 可以做的事",
      "",
      "- 用 Markdown 写标题、列表和 `代码`",
      "- 插入表情，例如完成 ✅、灵感 ✨",
      "- 把便签固定到桌面，或开启鼠标穿透",
      "- 建立待办，并设置周期性提醒",
      "",
      "> 开启穿透后点不到这张便签，按 `Ctrl+Alt+P` 可以关掉。",
      "",
      "按 `F1` 打开使用说明书。",
    ].join("\n");
    this.db.prepare(
      `INSERT INTO notes(id, category_id, title, content, note_type, color, pinned, archived, on_desktop,
        pin_desktop, always_on_top, click_through, opacity, pos_x, pos_y, width, height, created_at, updated_at, deleted)
       VALUES(?, ?, ?, ?, 'note', '#fff4c8', 1, 0, 0, 0, 0, 0, 1, NULL, NULL, 340, 420, ?, ?, 0)`
    ).run(noteId, idea, "从这里开始", welcome, now, now);
    const todoId = newId();
    this.db.prepare(
      `INSERT INTO notes(id, category_id, title, content, note_type, color, pinned, archived, on_desktop,
        pin_desktop, always_on_top, click_through, opacity, pos_x, pos_y, width, height, created_at, updated_at, deleted)
       VALUES(?, ?, ?, ?, 'todo', '#e5f6ee', 0, 0, 0, 0, 0, 0, 1, NULL, NULL, 320, 300, ?, ?, 0)`
    ).run(todoId, work, "第一张待办", "待办可以单独勾选，也可以给某一项设置提醒。", now, now);
    const insertTodo = this.db.prepare(
      "INSERT INTO todos(id, note_id, text, done, sort_order, due_at, created_at, updated_at, deleted) VALUES(?, ?, ?, 0, ?, NULL, ?, ?, 0)"
    );
    ["试试勾掉这一条", "给便签选一个分类", "设一个提醒，听一下提示音"].forEach((text, index) => {
      insertTodo.run(newId(), todoId, text, index, now, now);
    });
    const tomorrow = new Date(Date.now() + 86400000);
    tomorrow.setHours(9, 0, 0, 0);
    const remindAt = toIso(tomorrow);
    const offset = localOffsetMinutes();
    const nextFire = initialNextFire(parseIso(remindAt), "daily", 0, "0,1,2,3,4", new Date(), offset);
    this.db.prepare(
      `INSERT INTO reminders(id, note_id, title, remind_at, tz_offset_minutes, repeat_rule, interval_minutes,
        weekdays, sound, enabled, last_fired_at, next_fire_at, created_at, updated_at, deleted)
       VALUES(?, ?, ?, ?, ?, 'daily', 0, '0,1,2,3,4', 1, 0, NULL, ?, ?, ?, 0)`
    ).run(newId(), todoId, "示例：工作日早晨看一眼待办（默认关闭）", remindAt, offset, nextFire, now, now);
    this.setMeta("seeded", "1");
  }

  getMeta(key) {
    const record = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return record ? record.value : null;
  }

  setMeta(key, value) {
    this.db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
  }

  getSetting(key) {
    const record = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return record ? record.value : null;
  }

  setSetting(key, value) {
    this.db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
  }

  publicSettings() {
    const keys = [
      "sound_enabled", "close_to_tray", "autostart", "auto_sync_minutes", "theme",
      "sync_server", "sync_username", "last_sync_at", "device_id",
      "desktop_limit", "show_main_on_start",
    ];
    const data = {};
    keys.forEach((key) => {
      data[key] = this.getSetting(key) || "";
    });
    data.logged_in = Boolean(this.getSetting("sync_token"));
    return data;
  }

  shortcuts() {
    try {
      return JSON.parse(this.getSetting("shortcuts") || "[]");
    } catch (_error) {
      return DEFAULT_SHORTCUTS;
    }
  }

  addOpLog(ts, action, detail, ok) {
    this.db.prepare("INSERT INTO op_logs(ts, action, detail, ok) VALUES(?, ?, ?, ?)").run(
      ts, action, String(detail || "").slice(0, 2000), ok ? 1 : 0
    );
    const last = this.db.prepare("SELECT MAX(id) AS n FROM op_logs").get().n || 0;
    if (last % 200 === 0) {
      this.db.prepare(
        "DELETE FROM op_logs WHERE id NOT IN (SELECT id FROM op_logs ORDER BY id DESC LIMIT 5000)"
      ).run();
    }
  }

  addErrorLog(ts, source, message, traceback) {
    this.db.prepare(
      "INSERT INTO error_logs(ts, source, message, traceback) VALUES(?, ?, ?, ?)"
    ).run(ts, String(source).slice(0, 200), String(message).slice(0, 2000), String(traceback || "").slice(0, 8000));
    const last = this.db.prepare("SELECT MAX(id) AS n FROM error_logs").get().n || 0;
    if (last % 100 === 0) {
      this.db.prepare(
        "DELETE FROM error_logs WHERE id NOT IN (SELECT id FROM error_logs ORDER BY id DESC LIMIT 2000)"
      ).run();
    }
  }

  listLogs(kind, limit = 200, query = "") {
    const table = kind === "error" ? "error_logs" : "op_logs";
    const size = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const needle = `%${String(query || "").trim()}%`;
    if (String(query || "").trim()) {
      const column = table === "op_logs" ? "action LIKE ? OR detail LIKE ?" : "source LIKE ? OR message LIKE ?";
      return rows(this.db.prepare(`SELECT * FROM ${table} WHERE ${column} ORDER BY id DESC LIMIT ?`).all(needle, needle, size));
    }
    return rows(this.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT ?`).all(size));
  }

  listCategories(includeDeleted = false) {
    const sql = includeDeleted
      ? "SELECT * FROM categories ORDER BY sort_order, name"
      : "SELECT * FROM categories WHERE deleted = 0 ORDER BY sort_order, name";
    return rows(this.db.prepare(sql).all());
  }

  listNotes(includeDeleted = false) {
    const sql = includeDeleted
      ? "SELECT * FROM notes ORDER BY updated_at DESC"
      : "SELECT * FROM notes WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC";
    return rows(this.db.prepare(sql).all());
  }

  getNote(id) {
    return plain(this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
  }

  desktopNotes() {
    return rows(this.db.prepare(
      "SELECT * FROM notes WHERE deleted = 0 AND on_desktop = 1"
    ).all());
  }

  desktopTodos() {
    return rows(this.db.prepare("SELECT * FROM todos WHERE deleted = 0 AND on_desktop = 1").all());
  }

  desktopReminders() {
    return rows(this.db.prepare("SELECT * FROM reminders WHERE deleted = 0 AND on_desktop = 1").all());
  }

  desktopLimit() {
    return Math.max(1, Math.min(30, Number(this.getSetting("desktop_limit") || 8)));
  }

  setDesktopLimit(value) {
    const limit = Math.max(1, Math.min(30, Math.round(Number(value) || 8)));
    this.setSetting("desktop_limit", String(limit));
    return limit;
  }

  desktopCount() {
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted = 0 AND on_desktop = 1`).get().n;
    return count("notes") + count("todos") + count("reminders");
  }

  assertDesktopRoom() {
    const limit = this.desktopLimit();
    if (this.desktopCount() >= limit) throw new RuleError(`桌面上最多放 ${limit} 个。可以在桌面条上调高上限。`);
  }

  todoBucket() {
    const existing = this.getMeta("todo_bucket");
    if (existing) {
      const note = this.getNote(existing);
      if (note && !note.deleted) return existing;
    }
    const note = this.createNote("todo");
    this.updateNote(note.id, { title: "桌面待办" });
    this.setMeta("todo_bucket", note.id);
    return note.id;
  }

  getItem(table, id) {
    return plain(this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  }

  updateSurface(table, id, fields, options = {}) {
    const current = this.getItem(table, id);
    if (!current || current.deleted) throw new RuleError("内容不存在");
    const cleaned = this.cleanSurface(fields || {});
    if (cleaned.on_desktop === 1 && !current.on_desktop) this.assertDesktopRoom();
    const touch = options.touch !== false;
    if (!Object.keys(cleaned).length && !touch) return current;
    const assignments = Object.keys(cleaned).map((key) => `${key} = ?`);
    const values = Object.values(cleaned);
    if (touch && Object.keys(cleaned).length) {
      assignments.push("updated_at = ?");
      values.push(utcnowIso());
    }
    if (!assignments.length) return current;
    values.push(id);
    this.db.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return this.getItem(table, id);
  }

  cleanSurface(fields) {
    const out = {};
    if ("color" in fields) {
      const color = String(fields.color || "").trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new RuleError("颜色格式应为 #RRGGBB");
      out.color = color.toLowerCase();
    }
    ["on_desktop", "pin_desktop", "always_on_top", "click_through", "position_locked", "bg_transparent", "font_bold", "font_italic"].forEach((key) => {
      if (key in fields) out[key] = flag(fields[key]);
    });
    if (out.pin_desktop === 1) out.always_on_top = 0;
    if (out.always_on_top === 1) out.pin_desktop = 0;
    if ("opacity" in fields) {
      const opacity = Number(fields.opacity);
      if (Number.isNaN(opacity)) throw new RuleError("不透明度不正确");
      out.opacity = Math.min(1, Math.max(0.15, opacity));
    }
    ["pos_x", "pos_y"].forEach((key) => {
      if (key in fields) out[key] = fields[key] === null || fields[key] === "" ? null : Math.round(Number(fields[key]));
    });
    if ("width" in fields) out.width = Math.min(1600, Math.max(220, Math.round(Number(fields.width) || 280)));
    if ("height" in fields) out.height = Math.min(1200, Math.max(120, Math.round(Number(fields.height) || 160)));
    if ("font_family" in fields) {
      const family = String(fields.font_family || "");
      if (!FONTS.has(family)) throw new RuleError("不支持这个字体");
      out.font_family = family;
    }
    if ("font_size" in fields) {
      const size = Math.round(Number(fields.font_size));
      if (!size || size < 12 || size > 48) throw new RuleError("字号需要在 12 到 48 之间");
      out.font_size = size;
    }
    if ("font_color" in fields) {
      const color = String(fields.font_color || "").trim();
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new RuleError("字体颜色格式应为 #RRGGBB");
      out.font_color = color.toLowerCase();
    }
    return out;
  }

  createDesktop(kind) {
    if (kind === "note") return this.createNote("note");
    if (kind === "todo") return this.saveTodo({ note_id: this.todoBucket(), text: "新的待办" });
    if (kind === "reminder") {
      const when = new Date(Date.now() + 30 * 60000);
      return this.saveReminder({ title: "新提醒", remind_at: when.toISOString(), repeat_rule: "none", enabled: 1, sound: 1 });
    }
    throw new RuleError("类型不正确");
  }

  clearClickThrough() {
    ["notes", "todos", "reminders"].forEach((table) => {
      this.db.prepare(`UPDATE ${table} SET click_through = 0 WHERE deleted = 0 AND click_through = 1`).run();
    });
  }

  listTodos(noteId = "", includeDeleted = false) {
    const clauses = [];
    const params = [];
    if (!includeDeleted) clauses.push("deleted = 0");
    if (noteId) {
      clauses.push("note_id = ?");
      params.push(noteId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(this.db.prepare(`SELECT * FROM todos ${where} ORDER BY sort_order, created_at`).all(...params));
  }

  listReminders(includeDeleted = false) {
    const sql = includeDeleted
      ? "SELECT * FROM reminders ORDER BY next_fire_at"
      : "SELECT * FROM reminders WHERE deleted = 0 ORDER BY enabled DESC, next_fire_at";
    return rows(this.db.prepare(sql).all());
  }

  dueReminders(nowIso) {
    return rows(this.db.prepare(
      `SELECT * FROM reminders WHERE deleted = 0 AND enabled = 1 AND next_fire_at IS NOT NULL
       AND next_fire_at != '' AND next_fire_at <= ? ORDER BY next_fire_at`
    ).all(nowIso));
  }

  createNote(noteType = "note") {
    if (!NOTE_TYPES.includes(noteType)) throw new RuleError("便签类型不正确");
    const now = utcnowIso();
    const id = newId();
    const title = noteType === "todo" ? "未命名待办" : "未命名便签";
    const color = noteType === "todo" ? "#e5f6ee" : "#fffdf8";
    this.db.prepare(
      `INSERT INTO notes(id, category_id, title, content, note_type, color, pinned, archived, on_desktop,
        pin_desktop, always_on_top, click_through, opacity, pos_x, pos_y, width, height, created_at, updated_at, deleted)
       VALUES(?, NULL, ?, '', ?, ?, 0, 0, 0, 0, 0, 0, 1, NULL, NULL, 320, 280, ?, ?, 0)`
    ).run(id, title, noteType, color, now, now);
    return this.getNote(id);
  }

  updateNote(id, fields, options = {}) {
    const current = this.getNote(id);
    if (!current || current.deleted) throw new RuleError("便签不存在");
    const cleaned = this.cleanNote(fields || {});
    if (cleaned.on_desktop === 1 && !current.on_desktop) this.assertDesktopRoom();
    const touch = options.touch !== false;
    if (!Object.keys(cleaned).length && !touch) return current;
    const assignments = Object.keys(cleaned).map((key) => `${key} = ?`);
    const values = Object.values(cleaned);
    if (touch) {
      assignments.push("updated_at = ?");
      values.push(utcnowIso());
    }
    values.push(id);
    this.db.prepare(`UPDATE notes SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return this.getNote(id);
  }

  cleanNote(fields) {
    const out = {};
    if ("title" in fields) out.title = String(fields.title || "").slice(0, 200);
    if ("content" in fields) {
      const content = String(fields.content || "");
      if (content.length > 200000) throw new RuleError("正文超过 20 万字，请拆分后再保存");
      out.content = content;
    }
    if ("category_id" in fields) {
      const categoryId = String(fields.category_id || "").trim();
      if (!categoryId) out.category_id = null;
      else if (!this.db.prepare("SELECT id FROM categories WHERE id = ? AND deleted = 0").get(categoryId)) {
        throw new RuleError("分类不存在");
      } else out.category_id = categoryId;
    }
    if ("note_type" in fields) {
      if (!NOTE_TYPES.includes(fields.note_type)) throw new RuleError("便签类型不正确");
      out.note_type = fields.note_type;
    }
    ["pinned", "archived"].forEach((key) => {
      if (key in fields) out[key] = flag(fields[key]);
    });
    Object.assign(out, this.cleanSurface(fields));
    if ("width" in fields) out.width = Math.min(1600, Math.max(220, Math.round(Number(fields.width) || 320)));
    if ("height" in fields) out.height = Math.min(1200, Math.max(160, Math.round(Number(fields.height) || 280)));
    return out;
  }

  deleteNote(id) {
    if (!this.getNote(id)) throw new RuleError("便签不存在");
    const now = utcnowIso();
    this.db.prepare("UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?").run(now, id);
    this.db.prepare("UPDATE todos SET deleted = 1, updated_at = ? WHERE note_id = ? AND deleted = 0").run(now, id);
    this.db.prepare(
      "UPDATE reminders SET deleted = 1, enabled = 0, updated_at = ? WHERE note_id = ? AND deleted = 0"
    ).run(now, id);
  }

  saveCategory(payload) {
    const name = String(payload.name || "").trim();
    if (!name || name.length > 40) throw new RuleError("分类名称需要 1 到 40 个字符");
    const color = String(payload.color || "#0f6e6b").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new RuleError("颜色格式应为 #RRGGBB");
    const now = utcnowIso();
    const id = String(payload.id || "").trim() || newId();
    const existing = this.db.prepare("SELECT id FROM categories WHERE id = ?").get(id);
    if (existing) {
      this.db.prepare(
        "UPDATE categories SET name = ?, color = ?, updated_at = ?, deleted = 0 WHERE id = ?"
      ).run(name, color.toLowerCase(), now, id);
    } else {
      const sort = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories").get().n;
      this.db.prepare(
        "INSERT INTO categories(id, name, color, sort_order, created_at, updated_at, deleted) VALUES(?, ?, ?, ?, ?, ?, 0)"
      ).run(id, name, color.toLowerCase(), sort, now, now);
    }
    return plain(this.db.prepare("SELECT * FROM categories WHERE id = ?").get(id));
  }

  deleteCategory(id) {
    if (!this.db.prepare("SELECT id FROM categories WHERE id = ? AND deleted = 0").get(id)) {
      throw new RuleError("分类不存在");
    }
    const now = utcnowIso();
    this.db.prepare("UPDATE categories SET deleted = 1, updated_at = ? WHERE id = ?").run(now, id);
    this.db.prepare("UPDATE notes SET category_id = NULL, updated_at = ? WHERE category_id = ? AND deleted = 0").run(now, id);
  }

  saveTodo(payload) {
    const noteId = String(payload.note_id || "").trim();
    const note = this.getNote(noteId);
    if (!note || note.deleted) throw new RuleError("请先选择一张便签");
    const text = String(payload.text || "").trim();
    if (!text || text.length > 500) throw new RuleError("待办内容需要 1 到 500 个字符");
    let dueAt = String(payload.due_at || "").trim();
    dueAt = dueAt ? toIso(parseIso(dueAt)) : null;
    const now = utcnowIso();
    const id = String(payload.id || "").trim() || newId();
    const existing = plain(this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id));
    if (existing) {
      if (existing.note_id !== noteId) throw new RuleError("不能把待办移到另一张便签");
      this.db.prepare(
        "UPDATE todos SET text = ?, done = ?, due_at = ?, updated_at = ?, deleted = 0 WHERE id = ?"
      ).run(text, flag(payload.done ?? existing.done), dueAt, now, id);
    } else {
      const sort = this.db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM todos WHERE note_id = ?"
      ).get(noteId).n;
      this.db.prepare(
        `INSERT INTO todos(id, note_id, text, done, sort_order, due_at, created_at, updated_at, deleted)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).run(id, noteId, text, flag(payload.done), sort, dueAt, now, now);
    }
    this.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(now, noteId);
    const saved = plain(this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id));
    return this.hasSurface(payload) ? this.updateSurface("todos", saved.id, payload) : saved;
  }

  toggleTodo(id) {
    const current = plain(this.db.prepare("SELECT * FROM todos WHERE id = ? AND deleted = 0").get(id));
    if (!current) throw new RuleError("待办不存在");
    const now = utcnowIso();
    const done = current.done ? 0 : 1;
    this.db.prepare("UPDATE todos SET done = ?, updated_at = ? WHERE id = ?").run(done, now, id);
    this.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(now, current.note_id);
    return plain(this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id));
  }

  deleteTodo(id) {
    const current = plain(this.db.prepare("SELECT * FROM todos WHERE id = ? AND deleted = 0").get(id));
    if (!current) throw new RuleError("待办不存在");
    const now = utcnowIso();
    this.db.prepare("UPDATE todos SET deleted = 1, updated_at = ? WHERE id = ?").run(now, id);
    this.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(now, current.note_id);
  }

  saveReminder(payload) {
    const title = String(payload.title || "").trim();
    if (!title || title.length > 120) throw new RuleError("提醒标题需要 1 到 120 个字符");
    const rule = String(payload.repeat_rule || "none");
    if (!REPEAT_RULES.includes(rule)) throw new RuleError("不支持的重复规则");
    let interval = Number(payload.interval_minutes || 0);
    if (Number.isNaN(interval)) throw new RuleError("间隔分钟数不正确");
    interval = Math.max(0, Math.min(interval, 60 * 24 * 366));
    if (rule === "interval") interval = Math.max(1, interval);
    const weekdays = String(payload.weekdays || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^[0-6]$/.test(part))
      .join(",");
    const noteId = String(payload.note_id || "").trim();
    if (noteId && !this.db.prepare("SELECT id FROM notes WHERE id = ? AND deleted = 0").get(noteId)) {
      throw new RuleError("关联的便签不存在");
    }
    const remindAt = parseIso(payload.remind_at);
    const offset = Number(payload.tz_offset_minutes ?? localOffsetMinutes());
    const nextFire = initialNextFire(remindAt, rule, interval, weekdays, new Date(), offset);
    const now = utcnowIso();
    const id = String(payload.id || "").trim() || newId();
    const existing = this.db.prepare("SELECT id FROM reminders WHERE id = ?").get(id);
    const values = [
      title, noteId || null, toIso(remindAt), offset, rule, interval, weekdays,
      flag(payload.sound ?? 1), flag(payload.enabled ?? 1), nextFire || null, now, id,
    ];
    if (existing) {
      this.db.prepare(
        `UPDATE reminders SET title = ?, note_id = ?, remind_at = ?, tz_offset_minutes = ?, repeat_rule = ?,
         interval_minutes = ?, weekdays = ?, sound = ?, enabled = ?, next_fire_at = ?, updated_at = ?, deleted = 0
         WHERE id = ?`
      ).run(...values);
    } else {
      this.db.prepare(
        `INSERT INTO reminders(title, note_id, remind_at, tz_offset_minutes, repeat_rule, interval_minutes,
          weekdays, sound, enabled, next_fire_at, updated_at, id, last_fired_at, created_at, deleted)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`
      ).run(...values, now);
    }
    const saved = plain(this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
    return this.hasSurface(payload) ? this.updateSurface("reminders", saved.id, payload) : saved;
  }

  hasSurface(payload) {
    return ["on_desktop", "pin_desktop", "always_on_top", "click_through", "position_locked", "opacity", "color", "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic", "pos_x", "pos_y", "width", "height"].some((key) => key in (payload || {}));
  }

  deleteReminder(id) {
    if (!this.db.prepare("SELECT id FROM reminders WHERE id = ? AND deleted = 0").get(id)) {
      throw new RuleError("提醒不存在");
    }
    this.db.prepare("UPDATE reminders SET deleted = 1, enabled = 0, updated_at = ? WHERE id = ?").run(utcnowIso(), id);
  }

  settleReminder(id, fired) {
    const current = plain(this.db.prepare("SELECT * FROM reminders WHERE id = ? AND deleted = 0").get(id));
    if (!current) return null;
    let nextFire = advanceAfterFire(
      parseIso(current.remind_at), current.repeat_rule, current.interval_minutes,
      current.weekdays, new Date(), current.tz_offset_minutes
    );
    let enabled = nextFire ? 1 : 0;
    if (current.repeat_rule === "none") {
      enabled = 0;
      nextFire = "";
    }
    const now = utcnowIso();
    this.db.prepare(
      "UPDATE reminders SET enabled = ?, next_fire_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ?"
    ).run(enabled, nextFire || null, fired ? now : current.last_fired_at, now, id);
    return plain(this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
  }

  exportSince(since) {
    const changed = (table) => {
      if (since) return rows(this.db.prepare(`SELECT * FROM ${table} WHERE updated_at > ?`).all(since));
      return rows(this.db.prepare(`SELECT * FROM ${table}`).all());
    };
    return {
      device_id: this.getSetting("device_id") || "",
      categories: changed("categories"),
      notes: changed("notes"),
      todos: changed("todos"),
      reminders: changed("reminders"),
    };
  }

  applyBundle(bundle) {
    const stats = { applied: 0, kept: 0 };
    const mapping = {
      categories: CATEGORY_COLUMNS,
      notes: NOTE_COLUMNS,
      todos: TODO_COLUMNS,
      reminders: REMINDER_COLUMNS,
    };
    this.db.exec("BEGIN");
    try {
      Object.entries(mapping).forEach(([table, columns]) => {
        (bundle[table] || []).forEach((row) => {
          if (!row || !row.id) return;
          const existing = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(row.id);
          if (!remoteShouldReplace(existing && existing.updated_at, row.updated_at || "")) {
            stats.kept += 1;
            return;
          }
          this.upsert(table, row, columns);
          stats.applied += 1;
        });
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return stats;
  }

  upsert(table, row, columns) {
    const values = columns.map((column) => (column in row ? row[column] : null));
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`).join(", ");
    this.db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`
    ).run(...values);
  }

  snapshot() {
    return {
      categories: this.listCategories(),
      notes: this.listNotes(),
      todos: this.listTodos(),
      reminders: this.listReminders(),
      settings: this.publicSettings(),
      shortcuts: this.shortcuts(),
    };
  }
}

module.exports = { DesktopDb };
