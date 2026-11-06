"use strict";

const { screen } = require("electron");

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

let user32 = null;
let desktopHost = null;
let loadError = "";
const adjusting = new WeakSet();

function loadUser32() {
  if (process.platform !== "win32") return null;
  if (user32 || loadError) return user32;
  try {
    const koffi = require("koffi");
    const lib = koffi.load("user32.dll");
    user32 = {
      koffi,
      FindWindowW: lib.func("void * __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)"),
      FindWindowExW: lib.func("void * __stdcall FindWindowExW(void *parent, void *child, str16 cls, str16 name)"),
      SendMessageTimeoutW: lib.func("uintptr_t __stdcall SendMessageTimeoutW(void *hwnd, uint32 msg, uintptr_t wp, uintptr_t lp, uint32 flags, uint32 timeout, uintptr_t *result)"),
      SetParent: lib.func("void * __stdcall SetParent(void *child, void *parent)"),
      IsWindow: lib.func("int __stdcall IsWindow(void *hwnd)"),
      EnumWindows: lib.func("int __stdcall EnumWindows(void *callback, intptr_t lparam)"),
      GetAncestor: lib.func("void * __stdcall GetAncestor(void *hwnd, uint32 flags)"),
      GetWindowRect: lib.func("int __stdcall GetWindowRect(void *hwnd, void *rect)"),
      SetWindowPos: lib.func("int __stdcall SetWindowPos(void *hwnd, void *insertAfter, int x, int y, int cx, int cy, uint32 flags)"),
      GetWindowLongPtrW: lib.func("intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)"),
      SetWindowLongPtrW: lib.func("intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)"),
    };
  } catch (error) {
    loadError = error.message;
    user32 = null;
  }
  return user32;
}

function nativeHandle(win) {
  const api = loadUser32();
  if (!api || !win || win.isDestroyed()) return null;
  return api.koffi.decode(win.getNativeWindowHandle(), "void *");
}

function readRect(hwnd) {
  const api = loadUser32();
  const buffer = Buffer.alloc(16);
  if (!api.GetWindowRect(hwnd, buffer)) return null;
  const x = buffer.readInt32LE(0);
  const y = buffer.readInt32LE(4);
  return { x, y, width: buffer.readInt32LE(8) - x, height: buffer.readInt32LE(12) - y };
}

function findDesktopHost() {
  const api = loadUser32();
  if (!api) return null;
  if (desktopHost && api.IsWindow(desktopHost)) return desktopHost;
  const progman = api.FindWindowW("Progman", null);
  if (!progman) return null;
  const result = [0];
  api.SendMessageTimeoutW(progman, 0x052c, 0, 0, 0, 1000, result);
  let host = null;
  const callback = api.koffi.register((hwnd) => {
    const shell = api.FindWindowExW(hwnd, null, "SHELLDLL_DefView", null);
    if (shell) host = hwnd;
    return 1;
  }, api.koffi.pointer(api.koffi.proto("int __stdcall EnumWindowsProc(void *hwnd, intptr_t lparam)")));
  try {
    api.EnumWindows(callback, 0);
  } finally {
    api.koffi.unregister(callback);
  }
  if (!host && api.FindWindowExW(progman, null, "SHELLDLL_DefView", null)) host = progman;
  desktopHost = host || progman;
  return desktopHost;
}

function screenBoundsDip(win) {
  const api = loadUser32();
  const hwnd = nativeHandle(win);
  if (!api || !hwnd) return win.getBounds();
  const raw = readRect(hwnd);
  if (!raw) return win.getBounds();
  return screen.screenToDipRect(win, raw);
}

function placeOnHost(hwnd, host, screenBox) {
  const api = loadUser32();
  const parent = readRect(host) || { x: 0, y: 0 };
  const box = screenBox || readRect(hwnd);
  if (!box) return;
  api.SetWindowPos(
    hwnd,
    null,
    Math.round(box.x - parent.x),
    Math.round(box.y - parent.y),
    Math.round(box.width),
    Math.round(box.height),
    SWP_NOACTIVATE | SWP_SHOWWINDOW
  );
}

function setPassThrough(win, enabled) {
  const api = loadUser32();
  const hwnd = nativeHandle(win);
  if (!api || !hwnd) return;
  let style = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  style = enabled ? (style | WS_EX_TRANSPARENT) : (style & ~WS_EX_TRANSPARENT);
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
  api.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

function pinToDesktop(win) {
  if (process.platform !== "win32") {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    return "已贴到所有桌面空间";
  }
  const api = loadUser32();
  const hwnd = nativeHandle(win);
  const host = findDesktopHost();
  if (!api || !hwnd || !host) return "没有拿到桌面层，卡片仍是普通窗口";
  const before = readRect(hwnd);
  api.SetParent(hwnd, host);
  placeOnHost(hwnd, host, before);
  return "已贴进桌面";
}

function unpinFromDesktop(win) {
  if (process.platform !== "win32") {
    win.setVisibleOnAllWorkspaces(false);
    return "已离开桌面层";
  }
  const api = loadUser32();
  const hwnd = nativeHandle(win);
  if (!api || !hwnd) return "已离开桌面层";
  const dip = screenBoundsDip(win);
  api.SetParent(hwnd, null);
  win.setBounds(dip);
  return "已离开桌面层";
}

function applyWindowMode(win, item) {
  if (!win || win.isDestroyed()) return "";
  adjusting.add(win);
  const opacity = Math.min(1, Math.max(0.15, Number(item.opacity) || 1));
  win.setOpacity(opacity);
  const stuck = Boolean(item.pin_desktop) && !item.always_on_top;
  const onTop = Boolean(item.always_on_top) && !item.pin_desktop;
  const locked = Boolean(item.position_locked);
  if (typeof win.setMovable === "function") win.setMovable(!locked);
  if (typeof win.setResizable === "function") win.setResizable(!locked);
  win.setAlwaysOnTop(onTop, "floating");
  win.setIgnoreMouseEvents(Boolean(item.click_through), { forward: true });
  const message = stuck ? pinToDesktop(win) : unpinFromDesktop(win);
  setPassThrough(win, Boolean(item.click_through));
  setTimeout(() => adjusting.delete(win), 400);
  return message;
}

function reassertPin(win) {
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  const api = loadUser32();
  const hwnd = nativeHandle(win);
  const host = findDesktopHost();
  if (!api || !hwnd || !host) return;
  const current = api.GetAncestor(hwnd, 1);
  if (current !== host) {
    adjusting.add(win);
    const before = readRect(hwnd);
    api.SetParent(hwnd, host);
    placeOnHost(hwnd, host, before);
    setTimeout(() => adjusting.delete(win), 400);
  }
}

function isAdjusting(win) {
  return adjusting.has(win);
}

function platformError() {
  return loadError;
}

module.exports = {
  applyWindowMode,
  pinToDesktop,
  unpinFromDesktop,
  reassertPin,
  screenBoundsDip,
  isAdjusting,
  platformError,
};
