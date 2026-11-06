"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { RuleError, utcnowIso } = require("../shared/logic");
const { ServerDb } = require("./db");

const fails = new Map();

function dataDirectory() {
  return process.env.DESKNOTE_SERVER_DATA || path.join(__dirname, "data");
}

function createServer() {
  const directory = dataDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const database = new ServerDb(path.join(directory, "server.sqlite"), directory);
  database.init();
  const server = http.createServer((req, res) => {
    route(req, res, database).catch((error) => {
      database.error("http", error);
      send(res, 500, { ok: false, error: "服务器内部错误" });
    });
  });
  return { server, database, directory };
}

async function route(req, res, database) {
  const url = new URL(req.url, "http://127.0.0.1");
  const ip = req.socket.remoteAddress || "";
  if (req.method === "OPTIONS") return send(res, 204, null);
  if (url.pathname === "/" || url.pathname.startsWith("/admin.")) {
    return serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname);
  }
  if (!url.pathname.startsWith("/api/")) return send(res, 404, { ok: false, error: "没有这个地址" });

  const token = bearer(req);
  const user = database.userFromToken(token);
  try {
    const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
    const result = await dispatch(req.method, url, body, user, token, database, ip);
    send(res, result.status || 200, result.body);
  } catch (error) {
    const expose = error instanceof RuleError || error.expose;
    database.op("http", `${req.method} ${url.pathname}`, false, user, ip);
    if (!expose) database.error(url.pathname, error);
    send(res, error.status || (expose ? 400 : 500), {
      ok: false,
      error: expose ? error.message : "服务器内部错误",
    });
  }
}

async function dispatch(method, url, body, user, token, database, ip) {
  const routeName = `${method} ${url.pathname}`;
  if (routeName === "GET /api/health") return { body: { ok: true, time: utcnowIso() } };
  if (routeName === "POST /api/v1/auth/register") {
    database.createUser(body.username, body.password, body.display_name);
    const session = database.login(body.username, body.password);
    database.op("auth.register", body.username, true, session.user, ip);
    return { body: { ok: true, ...session } };
  }
  if (routeName === "POST /api/v1/auth/login" || routeName === "POST /api/admin/login") {
    if (limited(ip)) fail(429, "尝试次数过多，请稍后再试");
    try {
      const session = database.login(body.username, body.password);
      if (routeName.endsWith("/admin/login") && session.user.role !== "admin") fail(403, "需要管理员账号");
      database.op(routeName.endsWith("/admin/login") ? "admin.login" : "auth.login", body.username, true, session.user, ip);
      return { body: { ok: true, ...session } };
    } catch (error) {
      if (error.status && error.status !== 401) throw error;
      markFail(ip);
      if (!error.status) error.status = 401;
      throw error;
    }
  }
  if (!user) fail(401, "需要登录");
  if (routeName === "POST /api/v1/auth/logout") {
    database.logout(token);
    database.op("auth.logout", user.username, true, user, ip);
    return { body: { ok: true } };
  }
  if (routeName === "GET /api/v1/auth/me") return { body: { ok: true, user } };
  if (routeName === "GET /api/v1/sync/pull") {
    return { body: database.pull(user, url.searchParams.get("since") || "") };
  }
  if (routeName === "POST /api/v1/sync/push") {
    ["categories", "notes", "todos", "reminders"].forEach((key) => {
      if (body[key] && !Array.isArray(body[key])) fail(400, "同步数据格式不正确");
      if (body[key] && body[key].length > 5000) fail(400, "单次同步数据过多");
    });
    const result = database.applyPush(user, body);
    database.op("sync.push", body.device_id || "", true, user, ip);
    return { body: { ok: true, server_time: utcnowIso(), ...result } };
  }
  if (user.role !== "admin") fail(403, "需要管理员权限");
  if (routeName === "GET /api/admin/overview") return { body: { ok: true, ...database.overview() } };
  if (routeName === "GET /api/admin/users") return { body: { ok: true, users: database.listUsers() } };
  if (routeName === "GET /api/admin/notes") {
    return { body: { ok: true, notes: database.listNotes(url.searchParams.get("user_id") || "", url.searchParams.get("q") || "") } };
  }
  if (routeName === "GET /api/admin/reminders") return { body: { ok: true, reminders: database.listReminders() } };
  if (routeName === "GET /api/admin/logs") {
    return { body: { ok: true, logs: database.logs(url.searchParams.get("kind") || "op", url.searchParams.get("q") || "") } };
  }
  const noteMatch = url.pathname.match(/^\/api\/admin\/notes\/([a-zA-Z0-9]+)$/);
  if (method === "GET" && noteMatch) return { body: { ok: true, note: database.noteDetail(noteMatch[1]) } };
  const disableMatch = url.pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9]+)\/disable$/);
  if (method === "POST" && disableMatch) {
    if (disableMatch[1] === user.id) fail(400, "不能停用自己");
    database.setDisabled(disableMatch[1], Boolean(body.disabled));
    database.op("admin.disable", disableMatch[1], true, user, ip);
    return { body: { ok: true } };
  }
  const resetMatch = url.pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9]+)\/reset-password$/);
  if (method === "POST" && resetMatch) {
    const password = database.resetPassword(resetMatch[1]);
    database.op("admin.reset_password", resetMatch[1], true, user, ip);
    return { body: { ok: true, temp_password: password } };
  }
  if (routeName === "POST /api/admin/password") {
    database.changePassword(user.id, body.old_password, body.new_password);
    database.op("admin.password", user.username, true, user, ip);
    return { body: { ok: true } };
  }
  fail(404, "没有这个接口");
}

function fail(status, message) {
  const error = new RuleError(message);
  error.status = status;
  throw error;
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function limited(ip) {
  const now = Date.now();
  const recent = (fails.get(ip) || []).filter((time) => now - time < 600000);
  fails.set(ip, recent);
  return recent.length >= 8;
}

function markFail(ip) {
  const recent = fails.get(ip) || [];
  recent.push(Date.now());
  fails.set(ip, recent);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8000000) {
        reject(Object.assign(new RuleError("请求过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_error) {
        reject(Object.assign(new RuleError("请求不是 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
  };
  if (body == null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  const file = path.join(__dirname, "public", path.basename(pathname));
  if (!file.startsWith(path.join(__dirname, "public")) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "text/plain", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve(server.address());
    });
  });
}

async function listenLocal(port = 8787, host = process.env.DESKNOTE_HOST || "") {
  const { server, database, directory } = createServer();
  const chosen = host || "127.0.0.1";
  const address = await listenOn(server, port, chosen);
  const actual = address.port;
  const servers = [server];
  if (!host) {
    const extra = http.createServer(server.listeners("request")[0]);
    try {
      await listenOn(extra, actual, "::1");
      servers.push(extra);
    } catch (_error) {
      extra.close();
    }
  }
  return { servers, database, directory, port: actual, host: chosen };
}

if (require.main === module) {
  const port = Number(process.env.DESKNOTE_PORT || 8787);
  listenLocal(port).then(({ directory, host }) => {
    const passwordFile = path.join(directory, "initial_admin.txt");
    console.log(`DeskNote 后台已启动：http://${host}:${port}`);
    if (!process.env.DESKNOTE_HOST) console.log(`本机也可用：http://localhost:${port}`);
    console.log(`数据目录：${directory}`);
    if (fs.existsSync(passwordFile)) console.log(`初始管理员密码文件：${passwordFile}`);
    else console.log("管理员密码来自环境变量，或之前已经创建。");
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { createServer, listenLocal };
