"use strict";

const crypto = require("crypto");

const REPEAT_RULES = ["none", "daily", "weekly", "monthly", "interval"];
const NOTE_TYPES = ["note", "todo"];
const NOTE_COLORS = ["#fffdf8", "#fff4c8", "#ffe7d4", "#fde4ec", "#e5f6ee", "#e5f1fb", "#efe6fb"];

const DEFAULT_SHORTCUTS = [
  { action: "new_note", keys: "ctrl+alt+n", scope: "global", label: "新建便签" },
  { action: "new_todo", keys: "ctrl+alt+t", scope: "global", label: "新建待办" },
  { action: "toggle_main", keys: "ctrl+alt+space", scope: "global", label: "显示或隐藏主窗口" },
  { action: "toggle_clickthrough", keys: "ctrl+alt+p", scope: "global", label: "切换鼠标穿透" },
  { action: "sync_now", keys: "ctrl+alt+s", scope: "global", label: "立即同步" },
  { action: "search", keys: "ctrl+f", scope: "app", label: "搜索" },
  { action: "save", keys: "ctrl+s", scope: "app", label: "保存当前便签" },
  { action: "help", keys: "f1", scope: "app", label: "打开使用说明" },
];

const MODIFIERS = {
  ctrl: "CommandOrControl",
  control: "CommandOrControl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  cmd: "Command",
  command: "Command",
  win: "Super",
  meta: "Super",
  super: "Super",
};

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.expose = true;
  }
}

function utcnowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toIso(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseIso(value) {
  const text = String(value || "").trim();
  if (!text) throw new RuleError("时间为空");
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new RuleError("时间格式不正确");
  return parsed;
}

function localOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.pbkdf2Sync(password, salt, 200000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$200000$${salt}$${digest}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, rounds, salt, digest] = String(stored || "").split("$");
    if (algo !== "pbkdf2_sha256" || !salt || !digest) return false;
    const check = crypto.pbkdf2Sync(password, salt, Number(rounds), 32, "sha256").toString("hex");
    const left = Buffer.from(check);
    const right = Buffer.from(digest);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch (_error) {
    return false;
  }
}

function validUsername(name) {
  return /^[A-Za-z0-9_.-]{3,32}$/.test(name || "");
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 128;
}

function remoteShouldReplace(localUpdated, remoteUpdated) {
  if (!localUpdated) return true;
  if (!remoteUpdated) return false;
  return remoteUpdated > localUpdated;
}

function normalizeServerUrl(url) {
  const text = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(text)) throw new RuleError("服务器地址需要以 http:// 或 https:// 开头");
  return text;
}

function parseHotkey(combo) {
  const parts = String(combo || "")
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new RuleError("快捷键不能为空");
  const electronParts = [];
  parts.forEach((part) => {
    if (MODIFIERS[part]) {
      electronParts.push(MODIFIERS[part]);
      return;
    }
    if (/^[a-z0-9]$/.test(part) || /^f([1-9]|1\d|2[0-4])$/.test(part)) {
      electronParts.push(part.length === 1 ? part.toUpperCase() : part.toUpperCase());
      return;
    }
    const named = {
      space: "Space",
      tab: "Tab",
      enter: "Enter",
      esc: "Esc",
      escape: "Esc",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      backspace: "Backspace",
      delete: "Delete",
    };
    if (!named[part]) throw new RuleError(`无法识别的按键：${part}`);
    electronParts.push(named[part]);
  });
  if (electronParts.every((part) => ["CommandOrControl", "Alt", "Shift", "Command", "Super"].includes(part))) {
    throw new RuleError("快捷键需要包含一个主键");
  }
  return electronParts.join("+");
}

function normalizeShortcuts(items) {
  const incoming = new Map(
    (Array.isArray(items) ? items : [])
      .filter((item) => item && item.action)
      .map((item) => [String(item.action), item])
  );
  const seen = new Set();
  return DEFAULT_SHORTCUTS.map((fallback) => {
    const raw = incoming.get(fallback.action) || fallback;
    const keys = String(raw.keys || fallback.keys).trim().toLowerCase();
    const scope = String(raw.scope || fallback.scope).trim().toLowerCase();
    if (scope !== "global" && scope !== "app") throw new RuleError(`${fallback.label} 的作用范围不正确`);
    const binding = parseHotkey(keys);
    const marker = `${scope}:${binding}`;
    if (seen.has(marker)) throw new RuleError(`快捷键冲突：${keys}`);
    seen.add(marker);
    return { action: fallback.action, keys, scope, label: fallback.label, binding };
  });
}

function zonedParts(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  const jsDay = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: (jsDay + 6) % 7,
  };
}

function fromZoned(parts, offsetMinutes) {
  const utc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second || 0);
  return new Date(utc - offsetMinutes * 60000);
}

function addDays(parts, days) {
  const moved = new Date(Date.UTC(parts.year, parts.month, parts.day + days, parts.hour, parts.minute, parts.second || 0));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth(),
    day: moved.getUTCDate(),
    hour: moved.getUTCHours(),
    minute: moved.getUTCMinutes(),
    second: moved.getUTCSeconds(),
  };
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function parseWeekdays(value) {
  const found = new Set();
  String(value || "")
    .split(",")
    .forEach((part) => {
      if (/^[0-6]$/.test(part.trim())) found.add(Number(part.trim()));
    });
  return found;
}

function nextOccurrence(remindAt, rule, intervalMinutes, weekdays, now, offsetMinutes) {
  const ruleName = rule || "none";
  if (!REPEAT_RULES.includes(ruleName)) throw new RuleError("不支持的重复规则");
  const base = new Date(remindAt);
  const current = new Date(now);
  if (ruleName === "none") return base > current ? base : null;
  if (ruleName === "interval") {
    const minutes = Math.max(1, Math.min(Number(intervalMinutes) || 1, 60 * 24 * 366));
    const step = minutes * 60000;
    if (base > current) return base;
    const steps = Math.floor((current - base) / step) + 1;
    return new Date(base.getTime() + steps * step);
  }
  const offset = Number(offsetMinutes) || 0;
  const localBase = zonedParts(base, offset);
  const localNow = zonedParts(current, offset);
  if (ruleName === "daily") {
    let candidate = fromZoned(localBase, offset);
    if (candidate <= current) {
      const baseDay = Date.UTC(localBase.year, localBase.month, localBase.day);
      const nowDay = Date.UTC(localNow.year, localNow.month, localNow.day);
      const days = Math.max(0, Math.round((nowDay - baseDay) / 86400000));
      candidate = fromZoned(addDays(localBase, days), offset);
      if (candidate <= current) candidate = fromZoned(addDays(localBase, days + 1), offset);
    }
    return candidate;
  }
  if (ruleName === "weekly") {
    const selected = parseWeekdays(weekdays);
    if (!selected.size) selected.add(localBase.weekday);
    for (let index = 0; index < 21; index += 1) {
      const day = addDays(localNow, index);
      const probe = fromZoned({ ...day, hour: 12, minute: 0, second: 0 }, offset);
      if (!selected.has(zonedParts(probe, offset).weekday)) continue;
      const candidate = fromZoned(
        { ...day, hour: localBase.hour, minute: localBase.minute, second: localBase.second },
        offset
      );
      if (candidate > current) return candidate;
    }
    return null;
  }
  if (localBase && fromZoned(localBase, offset) > current) return fromZoned(localBase, offset);
  let year = localNow.year;
  let month = localNow.month;
  for (let index = 0; index < 36; index += 1) {
    const day = Math.min(localBase.day, daysInMonth(year, month));
    const candidate = fromZoned(
      { year, month, day, hour: localBase.hour, minute: localBase.minute, second: localBase.second },
      offset
    );
    if (candidate > current) return candidate;
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return null;
}

function initialNextFire(remindAt, rule, intervalMinutes, weekdays, now, offsetMinutes) {
  const base = new Date(remindAt);
  const current = new Date(now);
  if (base > current) return toIso(base);
  if ((rule || "none") === "none" || current - base <= 12 * 3600 * 1000) return toIso(base);
  const upcoming = nextOccurrence(base, rule, intervalMinutes, weekdays, current, offsetMinutes);
  return upcoming ? toIso(upcoming) : "";
}

function advanceAfterFire(remindAt, rule, intervalMinutes, weekdays, now, offsetMinutes) {
  if ((rule || "none") === "none") return "";
  const upcoming = nextOccurrence(remindAt, rule, intervalMinutes, weekdays, now, offsetMinutes);
  return upcoming ? toIso(upcoming) : "";
}

module.exports = {
  REPEAT_RULES,
  NOTE_TYPES,
  NOTE_COLORS,
  DEFAULT_SHORTCUTS,
  RuleError,
  utcnowIso,
  toIso,
  parseIso,
  localOffsetMinutes,
  newId,
  hashPassword,
  verifyPassword,
  validUsername,
  validPassword,
  remoteShouldReplace,
  normalizeServerUrl,
  parseHotkey,
  normalizeShortcuts,
  nextOccurrence,
  initialNextFire,
  advanceAfterFire,
};
