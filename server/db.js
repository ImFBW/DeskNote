"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  RuleError, hashPassword, newId, remoteShouldReplace, utcnowIso, validPassword, validUsername, verifyPassword,
} = require("../shared/logic");
const { ensureColumns, openDatabase, plain, rows, SURFACE_COLUMNS } = require("../shared/sqlite");

const COLUMN_DEFAULTS = {
  name: "", title: "", content: "", text: "", note_type: "note", color: "#fffdf8",
  pinned: 0, archived: 0, on_desktop: 0, pin_desktop: 0, always_on_top: 0, click_through: 0,
  opacity: 1, width: 320, height: 280, sort_order: 0, done: 0, deleted: 0, sound: 1, enabled: 1,
  repeat_rule: "none", interval_minutes: 0, weekdays: "", tz_offset_minutes: 0,
  bg_transparent: 0, font_family: "", font_size: 15, font_color: "", font_bold: 0, font_italic: 0,
};

function pushCell(column, row) {
  if (Object.prototype.hasOwnProperty.call(row, column) && row[column] !== undefined && row[column] !== null) {
    return typeof row[column] === "boolean" ? (row[column] ? 1 : 0) : row[column];
  }
  if (column === "created_at" || column === "updated_at") return row.updated_at || utcnowIso();
  return Object.prototype.hasOwnProperty.call(COLUMN_DEFAULTS, column) ? COLUMN_DEFAULTS[column] : null;
}

const TABLES = {
  categories: ["id", "name", "color", "sort_order", "created_at", "updated_at", "deleted"],
  notes: ["id", "category_id", "title", "content", "note_type", "color", "pinned", "archived", "on_desktop", "pin_desktop", "always_on_top", "click_through", "opacity", "pos_x", "pos_y", "width", "height", "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic", "created_at", "updated_at", "deleted"],
  todos: ["id", "note_id", "text", "done", "sort_order", "due_at", "on_desktop", "pin_desktop", "always_on_top", "click_through", "opacity", "pos_x", "pos_y", "width", "height", "color", "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic", "created_at", "updated_at", "deleted"],
  reminders: ["id", "note_id", "title", "remind_at", "tz_offset_minutes", "repeat_rule", "interval_minutes", "weekdays", "sound", "enabled", "last_fired_at", "next_fire_at", "on_desktop", "pin_desktop", "always_on_top", "click_through", "opacity", "pos_x", "pos_y", "width", "height", "color", "bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic", "created_at", "updated_at", "deleted"],
};

const STYLE_ONLY = SURFACE_COLUMNS.filter(([name]) => ["bg_transparent", "font_family", "font_size", "font_color", "font_bold", "font_italic"].includes(name));

class ServerDb {
  constructor(file, dataDir) {
    this.file = file;
    this.dataDir = dataDir;
    this.db = openDatabase(file);
  }

  init() {
    [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category_id TEXT, title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', note_type TEXT NOT NULL DEFAULT 'note', color TEXT NOT NULL DEFAULT '#fffdf8',
        pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, on_desktop INTEGER NOT NULL DEFAULT 0,
        pin_desktop INTEGER NOT NULL DEFAULT 0, always_on_top INTEGER NOT NULL DEFAULT 0, click_through INTEGER NOT NULL DEFAULT 0,
        opacity REAL NOT NULL DEFAULT 1, pos_x INTEGER, pos_y INTEGER, width INTEGER NOT NULL DEFAULT 320,
        height INTEGER NOT NULL DEFAULT 280, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT NOT NULL, text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, due_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT, title TEXT NOT NULL, remind_at TEXT NOT NULL,
        tz_offset_minutes INTEGER NOT NULL DEFAULT 0, repeat_rule TEXT NOT NULL DEFAULT 'none',
        interval_minutes INTEGER NOT NULL DEFAULT 0, weekdays TEXT NOT NULL DEFAULT '', sound INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1, last_fired_at TEXT, next_fire_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS op_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_id TEXT, username TEXT, ip TEXT,
        action TEXT NOT NULL, detail TEXT, ok INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, traceback TEXT)`,
    ].forEach((sql) => this.db.exec(sql));
    ensureColumns(this.db, "notes", STYLE_ONLY);
    ensureColumns(this.db, "todos", SURFACE_COLUMNS);
    ensureColumns(this.db, "reminders", SURFACE_COLUMNS);
    this.ensureAdmin();
  }

  ensureAdmin() {
    const existing = this.db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
    if (existing) return;
    const username = process.env.DESKNOTE_ADMIN_USER || "admin";
    const fromEnv = process.env.DESKNOTE_ADMIN_PASSWORD || "";
    const password = fromEnv || crypto.randomBytes(9).toString("base64url");
    const now = utcnowIso();
    this.db.prepare(
      `INSERT INTO users(id, username, password_hash, display_name, role, disabled, created_at, updated_at)
       VALUES(?, ?, ?, '管理员', 'admin', 0, ?, ?)`
    ).run(newId(), username, hashPassword(password), now, now);
    this.setMeta("password_changed", "0");
    if (!fromEnv) {
      const file = path.join(this.dataDir, "initial_admin.txt");
      fs.writeFileSync(file, `用户名: ${username}\n初始密码: ${password}\n请登录后台后立即修改。\n`, "utf8");
    }
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  op(action, detail, ok, user, ip) {
    this.db.prepare(
      "INSERT INTO op_logs(ts, user_id, username, ip, action, detail, ok) VALUES(?, ?, ?, ?, ?, ?, ?)"
    ).run(utcnowIso(), user && user.id, user && user.username, ip || "", action, String(detail || "").slice(0, 2000), ok ? 1 : 0);
  }

  error(source, error) {
    const message = error && error.message ? error.message : String(error);
    const stack = error && error.stack ? error.stack : "";
    this.db.prepare("INSERT INTO error_logs(ts, source, message, traceback) VALUES(?, ?, ?, ?)").run(
      utcnowIso(), source, message.slice(0, 2000), stack.slice(0, 8000)
    );
  }

  createUser(username, password, displayName) {
    if (!validUsername(username)) throw new RuleError("用户名需要 3 到 32 位字母、数字、点、下划线或短横线");
    if (!validPassword(password)) throw new RuleError("密码至少 6 位");
    if (this.db.prepare("SELECT id FROM users WHERE username = ?").get(username)) throw new RuleError("用户名已存在");
    const now = utcnowIso();
    const id = newId();
    this.db.prepare(
      `INSERT INTO users(id, username, password_hash, display_name, role, disabled, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'user', 0, ?, ?)`
    ).run(id, username, hashPassword(password), String(displayName || username).slice(0, 40), now, now);
    return this.publicUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  login(username, password) {
    const user = plain(this.db.prepare("SELECT * FROM users WHERE username = ?").get(username));
    if (!user || !verifyPassword(password, user.password_hash)) throw new RuleError("用户名或密码不正确");
    if (user.disabled) throw new RuleError("账号已停用");
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.prepare("INSERT INTO tokens(token_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)").run(
      sha(token), user.id, utcnowIso(), expires
    );
    return { token, user: this.publicUser(user) };
  }

  logout(token) {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha(token));
  }

  userFromToken(token) {
    if (!token) return null;
    const row = plain(this.db.prepare(
      `SELECT users.* FROM tokens JOIN users ON users.id = tokens.user_id
       WHERE tokens.token_hash = ? AND tokens.expires_at > ? AND users.disabled = 0`
    ).get(sha(token), utcnowIso()));
    return row ? this.publicUser(row, true) : null;
  }

  publicUser(user, internal = false) {
    const data = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      disabled: user.disabled,
      created_at: user.created_at,
    };
    if (internal) data.role = user.role;
    return data;
  }

  changePassword(userId, oldPassword, newPassword) {
    const user = plain(this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
    if (!user || !verifyPassword(oldPassword, user.password_hash)) throw new RuleError("原密码不正确");
    if (!validPassword(newPassword)) throw new RuleError("新密码至少 6 位");
    this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(newPassword), utcnowIso(), userId);
    this.setMeta("password_changed", "1");
  }

  resetPassword(userId) {
    const password = crypto.randomBytes(6).toString("base64url");
    this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(password), utcnowIso(), userId);
    this.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
    return password;
  }

  setDisabled(userId, disabled) {
    this.db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?").run(disabled ? 1 : 0, utcnowIso(), userId);
    if (disabled) this.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
  }

  listUsers() {
    return rows(this.db.prepare(
      "SELECT id, username, display_name, role, disabled, created_at, updated_at FROM users ORDER BY created_at"
    ).all());
  }

  overview() {
    const count = (sql) => this.db.prepare(sql).get().n;
    const since = new Date(Date.now() - 86400000).toISOString();
    return {
      users: count("SELECT COUNT(*) AS n FROM users"),
      notes: count("SELECT COUNT(*) AS n FROM notes WHERE deleted = 0"),
      todos: count("SELECT COUNT(*) AS n FROM todos WHERE deleted = 0"),
      reminders: count("SELECT COUNT(*) AS n FROM reminders WHERE deleted = 0"),
      ops_24h: this.db.prepare("SELECT COUNT(*) AS n FROM op_logs WHERE ts >= ?").get(since).n,
      errors_24h: this.db.prepare("SELECT COUNT(*) AS n FROM error_logs WHERE ts >= ?").get(since).n,
      server_time: utcnowIso(),
      password_changed: this.getMeta("password_changed") === "1",
      data_dir: this.dataDir,
    };
  }

  applyPush(user, bundle) {
    const applied = { categories: 0, notes: 0, todos: 0, reminders: 0 };
    const skipped = { categories: 0, notes: 0, todos: 0, reminders: 0 };
    this.db.exec("BEGIN");
    try {
      Object.entries(TABLES).forEach(([table, columns]) => {
        (bundle[table] || []).forEach((row) => {
          if (!row || !row.id || String(row.id).length > 64) return;
          if (table === "notes" && String(row.content || "").length > 200000) {
            skipped[table] += 1;
            return;
          }
          const owner = this.db.prepare(`SELECT user_id, updated_at FROM ${table} WHERE id = ?`).get(row.id);
          if (owner && owner.user_id !== user.id) {
            skipped[table] += 1;
            return;
          }
          if (owner && !remoteShouldReplace(owner.updated_at, row.updated_at || "")) {
            skipped[table] += 1;
            return;
          }
          const values = columns.map((column) => pushCell(column, row));
          const updates = columns.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`);
          this.db.prepare(
            `INSERT INTO ${table} (user_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})
             ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, ${updates.join(", ")}`
          ).run(user.id, ...values);
          applied[table] += 1;
        });
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { applied, skipped };
  }

  pull(user, since) {
    const query = (table) => {
      const sql = since
        ? `SELECT * FROM ${table} WHERE user_id = ? AND updated_at > ?`
        : `SELECT * FROM ${table} WHERE user_id = ?`;
      const records = since ? this.db.prepare(sql).all(user.id, since) : this.db.prepare(sql).all(user.id);
      return records.map((record) => {
        const copy = { ...record };
        delete copy.user_id;
        return copy;
      });
    };
    return {
      ok: true,
      server_time: utcnowIso(),
      categories: query("categories"),
      notes: query("notes"),
      todos: query("todos"),
      reminders: query("reminders"),
    };
  }

  listNotes(userId, queryText) {
    const needle = `%${queryText || ""}%`;
    const sql = userId
      ? `SELECT notes.id, notes.user_id, users.username, notes.title, notes.note_type, notes.updated_at, notes.deleted, length(notes.content) AS size
         FROM notes JOIN users ON users.id = notes.user_id
         WHERE notes.user_id = ? AND (notes.title LIKE ? OR users.username LIKE ?) ORDER BY notes.updated_at DESC LIMIT 300`
      : `SELECT notes.id, notes.user_id, users.username, notes.title, notes.note_type, notes.updated_at, notes.deleted, length(notes.content) AS size
         FROM notes JOIN users ON users.id = notes.user_id
         WHERE notes.title LIKE ? OR users.username LIKE ? ORDER BY notes.updated_at DESC LIMIT 300`;
    const params = userId ? [userId, needle, needle] : [needle, needle];
    return rows(this.db.prepare(sql).all(...params));
  }

  noteDetail(id) {
    return plain(this.db.prepare(
      `SELECT notes.*, users.username FROM notes JOIN users ON users.id = notes.user_id WHERE notes.id = ?`
    ).get(id));
  }

  listReminders() {
    return rows(this.db.prepare(
      `SELECT reminders.id, reminders.title, reminders.remind_at, reminders.repeat_rule, reminders.enabled,
              reminders.updated_at, users.username
       FROM reminders JOIN users ON users.id = reminders.user_id ORDER BY reminders.updated_at DESC LIMIT 300`
    ).all());
  }

  logs(kind, queryText) {
    const needle = `%${queryText || ""}%`;
    if (kind === "error") {
      return rows(this.db.prepare(
        "SELECT * FROM error_logs WHERE source LIKE ? OR message LIKE ? ORDER BY id DESC LIMIT 300"
      ).all(needle, needle));
    }
    return rows(this.db.prepare(
      "SELECT * FROM op_logs WHERE action LIKE ? OR detail LIKE ? OR username LIKE ? ORDER BY id DESC LIMIT 300"
    ).all(needle, needle, needle));
  }
}

function sha(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { ServerDb };
