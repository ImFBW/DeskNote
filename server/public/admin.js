"use strict";

const state = { page: "overview", token: sessionStorage.getItem("desknote-admin") || "" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { logout(); throw new Error(data.error || "需要登录"); }
  if (!response.ok || data.ok === false) throw new Error(data.error || "请求失败");
  return data;
}

function logout() {
  state.token = "";
  sessionStorage.removeItem("desknote-admin");
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("shell").classList.add("hidden");
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const error = document.getElementById("login-error");
  error.textContent = "";
  try {
    const data = await api("/api/admin/login", { method: "POST", body: { username: form.get("username"), password: form.get("password") } });
    state.token = data.token;
    sessionStorage.setItem("desknote-admin", data.token);
    showShell();
  } catch (err) {
    error.textContent = err.message === "Failed to fetch"
      ? "连不上后台接口。请先启动 DeskNote 或执行 npm run server，再用 http://127.0.0.1:8787 打开。不要直接双击 html 文件。"
      : err.message;
  }
});

if (location.protocol === "file:") {
  document.getElementById("login-error").textContent = "页面是从磁盘打开的，浏览器会拦截接口请求（Failed to fetch）。请改用 http://127.0.0.1:8787 。";
} else {
  fetch("/api/health").catch(() => {
    const error = document.getElementById("login-error");
    if (!error.textContent) error.textContent = "后台服务没有响应。请确认 DeskNote 正在运行，并用 http://127.0.0.1:8787 访问。";
  });
}

document.getElementById("logout").addEventListener("click", async () => {
  try { await api("/api/v1/auth/logout", { method: "POST", body: {} }); } catch (_error) { /* 本地仍退出 */ }
  logout();
});

document.querySelector("aside").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (!button) return;
  state.page = button.dataset.page;
  document.querySelectorAll("aside button[data-page]").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

function showShell() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("shell").classList.remove("hidden");
  render();
}

async function render() {
  const main = document.getElementById("main");
  main.innerHTML = "<p>正在读取…</p>";
  try {
    if (state.page === "overview") main.innerHTML = await overview();
    if (state.page === "users") main.innerHTML = await users();
    if (state.page === "notes") main.innerHTML = await notes();
    if (state.page === "reminders") main.innerHTML = await reminders();
    if (state.page === "logs") main.innerHTML = await logs();
    if (state.page === "account") main.innerHTML = account();
  } catch (error) { main.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}

async function overview() {
  const data = await api("/api/admin/overview");
  const warn = data.password_changed ? "" : '<p class="warn">初始管理员密码还没改。请到「账号」里修改。</p>';
  return `${warn}<h1>概览</h1><div class="grid">
    ${stat("用户", data.users)}${stat("便签", data.notes)}${stat("待办", data.todos)}
    ${stat("提醒", data.reminders)}${stat("24 小时操作", data.ops_24h)}${stat("24 小时错误", data.errors_24h)}
  </div><p>服务器时间 ${escapeHtml(data.server_time)}</p><p>数据目录 ${escapeHtml(data.data_dir)}</p>`;
}

function stat(label, value) { return `<article class="card stat"><span>${label}</span><strong>${value}</strong></article>`; }

async function users() {
  const data = await api("/api/admin/users");
  const rows = data.users.map((user) => `<tr>
    <td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td>${user.disabled ? "停用" : "正常"}</td><td>${escapeHtml(user.created_at)}</td>
    <td><button type="button" class="quiet" data-act="disable" data-id="${user.id}" data-disabled="${user.disabled ? 0 : 1}">${user.disabled ? "启用" : "停用"}</button>
    <button type="button" class="quiet" data-act="reset" data-id="${user.id}">重置密码</button></td></tr>`).join("");
  return `<h1>用户</h1><table><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th></th></tr>${rows}</table><p id="temp"></p>`;
}

async function notes() {
  const query = state.noteQuery || "";
  const data = await api(`/api/admin/notes?q=${encodeURIComponent(query)}`);
  const rows = data.notes.map((note) => `<tr><td>${escapeHtml(note.username)}</td><td>${escapeHtml(note.title)}</td><td>${escapeHtml(note.note_type)}</td><td>${note.size}</td><td>${note.deleted ? "已删" : "正常"}</td><td><button type="button" class="quiet" data-act="note" data-id="${note.id}">查看</button></td></tr>`).join("");
  return `<h1>便签</h1><div class="row"><input id="note-q" value="${escapeHtml(query)}" placeholder="搜索标题或用户"><button type="button" id="note-search">搜索</button></div>
    <table><tr><th>用户</th><th>标题</th><th>类型</th><th>字数</th><th>状态</th><th></th></tr>${rows}</table><div id="note-detail"></div>`;
}

async function reminders() {
  const data = await api("/api/admin/reminders");
  const rows = data.reminders.map((item) => `<tr><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.repeat_rule)}</td><td>${item.enabled ? "启用" : "关闭"}</td><td>${escapeHtml(item.remind_at)}</td></tr>`).join("");
  return `<h1>提醒</h1><table><tr><th>用户</th><th>标题</th><th>重复</th><th>状态</th><th>时间</th></tr>${rows}</table>`;
}

async function logs() {
  const kind = state.logKind || "op";
  const data = await api(`/api/admin/logs?kind=${kind}&q=${encodeURIComponent(state.logQuery || "")}`);
  const rows = data.logs.map((row) => kind === "error"
    ? `<tr><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.message)}</td></tr>`
    : `<tr><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.username || "")}</td><td>${row.ok ? "成功" : "失败"}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.detail || "")}</td></tr>`).join("");
  const head = kind === "error" ? "<tr><th>时间</th><th>来源</th><th>内容</th></tr>" : "<tr><th>时间</th><th>用户</th><th>结果</th><th>动作</th><th>详情</th></tr>";
  return `<h1>日志</h1><div class="row"><button type="button" data-log="op" class="${kind === "op" ? "" : "quiet"}">操作</button><button type="button" data-log="error" class="${kind === "error" ? "" : "quiet"}">错误</button><input id="log-q" value="${escapeHtml(state.logQuery || "")}" placeholder="筛选"><button type="button" id="log-search">搜索</button></div><table>${head}${rows}</table>`;
}

function account() {
  return `<h1>账号</h1><form id="password-form" class="card"><h2>修改管理员密码</h2>
    <label>原密码<input name="old_password" type="password" required></label>
    <label>新密码<input name="new_password" type="password" required></label>
    <button type="submit">保存</button><p id="password-msg"></p></form>`;
}

document.body.addEventListener("click", async (event) => {
  const node = event.target.closest("[data-act], [data-log], #note-search, #log-search");
  if (!node) return;
  try {
    if (node.dataset.act === "disable") {
      await api(`/api/admin/users/${node.dataset.id}/disable`, { method: "POST", body: { disabled: node.dataset.disabled === "1" } });
      render();
    }
    if (node.dataset.act === "reset") {
      const data = await api(`/api/admin/users/${node.dataset.id}/reset-password`, { method: "POST", body: {} });
      document.getElementById("temp").textContent = `临时密码只显示这一次：${data.temp_password}`;
    }
    if (node.dataset.act === "note") {
      const data = await api(`/api/admin/notes/${node.dataset.id}`);
      document.getElementById("note-detail").innerHTML = `<article class="card"><h2>${escapeHtml(data.note.title)}</h2><p>${escapeHtml(data.note.username)}</p><pre>${escapeHtml(data.note.content || "")}</pre></article>`;
    }
    if (node.dataset.log) { state.logKind = node.dataset.log; render(); }
    if (node.id === "note-search") { state.noteQuery = document.getElementById("note-q").value; render(); }
    if (node.id === "log-search") { state.logQuery = document.getElementById("log-q").value; render(); }
  } catch (error) { alert(error.message); }
});

document.body.addEventListener("submit", async (event) => {
  if (event.target.id !== "password-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  const message = document.getElementById("password-msg");
  try {
    await api("/api/admin/password", { method: "POST", body: { old_password: form.get("old_password"), new_password: form.get("new_password") } });
    message.textContent = "密码已修改";
  } catch (error) { message.textContent = error.message; }
});

if (state.token) showShell();
