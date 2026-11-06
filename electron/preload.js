"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const channels = new Set([
  "bootstrap", "note:create", "note:save", "note:delete", "category:save", "category:delete",
  "todo:save", "todo:toggle", "todo:delete", "reminder:save", "reminder:delete", "reminder:check",
  "settings:save", "sound:test", "sync:register", "sync:login", "sync:logout", "sync:now",
  "logs:list", "logs:export", "folder:data", "folder:logs", "help:manual", "sticky:open",
  "sticky:state", "sticky:close", "bubble:open", "link:open", "desk:create", "desk:open",
  "desk:state", "desk:close", "desk:delete", "desk:limit", "dock:state", "through:clear",
  "admin:open", "main:show",
]);

contextBridge.exposeInMainWorld("desknote", {
  invoke(channel, payload) {
    if (!channels.has(channel)) return Promise.resolve({ ok: false, error: "不允许的操作" });
    return ipcRenderer.invoke(channel, payload || {});
  },
  on(channel, callback) {
    if (channel !== "data:changed") return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
