"use strict";

const $ = (id) => document.getElementById(id);

async function refresh() {
  const result = await window.desknote.invoke("dock:state");
  if (!result.ok) return;
  if (document.activeElement !== $("limit")) $("limit").value = result.limit;
  $("count").textContent = `当前 ${result.count} / ${result.limit}`;
}

async function create(kind) {
  const result = await window.desknote.invoke("desk:create", { kind });
  $("status").textContent = result.ok ? "" : (result.error || "没有创建");
  refresh();
}

$("note").addEventListener("click", () => create("note"));
$("todo").addEventListener("click", () => create("todo"));
$("reminder").addEventListener("click", () => create("reminder"));
$("clear").addEventListener("click", async () => {
  await window.desknote.invoke("through:clear");
  $("status").textContent = "已关闭鼠标穿透";
});
$("main").addEventListener("click", () => window.desknote.invoke("main:show"));
$("admin").addEventListener("click", () => window.desknote.invoke("admin:open"));
$("limit").addEventListener("change", async () => {
  const result = await window.desknote.invoke("desk:limit", { limit: Number($("limit").value) });
  $("status").textContent = result.ok ? "" : (result.error || "上限没有保存");
  refresh();
});
window.desknote.on("data:changed", refresh);
refresh();
