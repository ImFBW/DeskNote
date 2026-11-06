"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desknote-smoke-"));
const electron = require("electron");
const child = spawn(electron, [path.join(__dirname, ".."), "--smoke"], {
  env: { ...process.env, DESKNOTE_DATA: dir },
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code || 0));
