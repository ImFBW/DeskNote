"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

function plain(record) {
  return record ? { ...record } : null;
}

function rows(records) {
  return records.map((record) => ({ ...record }));
}

const SURFACE_COLUMNS = [
  ["on_desktop", "INTEGER NOT NULL DEFAULT 0"],
  ["pin_desktop", "INTEGER NOT NULL DEFAULT 0"],
  ["always_on_top", "INTEGER NOT NULL DEFAULT 0"],
  ["click_through", "INTEGER NOT NULL DEFAULT 0"],
  ["opacity", "REAL NOT NULL DEFAULT 1"],
  ["pos_x", "INTEGER"],
  ["pos_y", "INTEGER"],
  ["width", "INTEGER NOT NULL DEFAULT 280"],
  ["height", "INTEGER NOT NULL DEFAULT 180"],
  ["color", "TEXT NOT NULL DEFAULT '#fffdf8'"],
  ["bg_transparent", "INTEGER NOT NULL DEFAULT 0"],
  ["font_family", "TEXT NOT NULL DEFAULT ''"],
  ["font_size", "INTEGER NOT NULL DEFAULT 15"],
  ["font_color", "TEXT NOT NULL DEFAULT ''"],
  ["font_bold", "INTEGER NOT NULL DEFAULT 0"],
  ["font_italic", "INTEGER NOT NULL DEFAULT 0"],
];

function ensureColumns(db, table, columns) {
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  columns.forEach(([name, ddl]) => {
    if (!names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  });
}

module.exports = { openDatabase, plain, rows, SURFACE_COLUMNS, ensureColumns };
