"use strict";

const fs = require("fs");
const path = require("path");
const { utcnowIso } = require("../shared/logic");

class Logger {
  constructor(db, directory) {
    this.db = db;
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.opPath = path.join(directory, "operation.log");
    this.errPath = path.join(directory, "error.log");
    this.auto = new Map();
  }

  operation(action, detail = "", ok = true, persist = true) {
    const ts = utcnowIso();
    this.append(this.opPath, `${ts}\t${ok ? "OK" : "FAIL"}\t${action}\t${detail}`);
    if (!persist) return;
    try {
      this.db.addOpLog(ts, action, detail, ok);
    } catch (_error) {
      this.append(this.errPath, `${ts}\tlog\t操作日志写入数据库失败\t${action}`);
    }
  }

  error(source, error) {
    const ts = utcnowIso();
    const message = error && error.message ? error.message : String(error);
    const stack = error && error.stack ? error.stack : "";
    this.append(this.errPath, `${ts}\t${source}\t${message}\n${stack}`.trim());
    try {
      this.db.addErrorLog(ts, source, message, stack);
    } catch (_error) {
      this.append(this.errPath, `${ts}\tlog\t错误日志写入数据库失败\t${source}`);
    }
  }

  allowAuto(noteId) {
    const now = Date.now();
    if (now - (this.auto.get(noteId) || 0) < 300000) return false;
    this.auto.set(noteId, now);
    return true;
  }

  append(file, line) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2000000) {
        const backup = `${file}.1`;
        if (fs.existsSync(backup)) fs.rmSync(backup);
        fs.renameSync(file, backup);
      }
      fs.appendFileSync(file, `${line}\n`, "utf8");
    } catch (_error) {
      /* 磁盘日志失败时不再向外抛，避免把主流程带崩。 */
    }
  }
}

module.exports = { Logger };
