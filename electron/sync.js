"use strict";

const http = require("http");
const https = require("https");
const { RuleError, normalizeServerUrl } = require("../shared/logic");

function requestJson(server, route, { method = "GET", token = "", body = null } = {}) {
  const base = normalizeServerUrl(server);
  const target = new URL(route, `${base}/`);
  const lib = target.protocol === "https:" ? https : http;
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").slice(0, 2000000);
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_error) {
            reject(new RuleError("服务器返回的不是 JSON"));
            return;
          }
          if (res.statusCode >= 400 || data.ok === false) {
            const message = data.error || (res.statusCode === 401 ? "登录已失效，请重新登录" : `服务器返回 ${res.statusCode}`);
            const error = new RuleError(message);
            error.status = res.statusCode;
            reject(error);
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => req.destroy(new RuleError("连接同步服务器超时")));
    req.on("error", (error) => {
      if (error instanceof RuleError) reject(error);
      else reject(new RuleError("无法连接同步服务器"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { requestJson };
