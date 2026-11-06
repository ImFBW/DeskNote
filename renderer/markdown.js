"use strict";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function safeUrl(url) {
  const text = String(url || "").trim();
  return /^(https?:|mailto:)/i.test(text) ? text : "";
}

function renderInline(escaped) {
  const codes = [];
  let text = escaped.replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const href = safeUrl(url);
    if (!href) return label;
    return `<a href="${escapeHtml(href)}" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codes[Number(index)]}</code>`);
}

function isBlockStart(line) {
  return /^(#{1,3}\s+|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|\|)/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line);
}

function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const buffer = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        buffer.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code>${escapeHtml(buffer.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const splitRow = (raw) => raw.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      const header = splitRow(line);
      index += 2;
      const body = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        body.push(splitRow(lines[index]));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join("");
      const rowsHtml = body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(escapeHtml(cell))}</td>`).join("")}</tr>`).join("");
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      html.push(`<h${heading[1].length}>${renderInline(escapeHtml(heading[2]))}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const buffer = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        buffer.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderInline(escapeHtml(buffer.join(" ")))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const raw = lines[index].replace(/^\s*[-*]\s+/, "");
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(raw);
        if (task) {
          items.push(`<li>${task[1].toLowerCase() === "x" ? "☑" : "☐"} ${renderInline(escapeHtml(task[2]))}</li>`);
        } else items.push(`<li>${renderInline(escapeHtml(raw))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(escapeHtml(lines[index].replace(/^\s*\d+\.\s+/, "")))}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
  }
  return html.join("");
}
