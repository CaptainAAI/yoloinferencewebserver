// Dashboard logic. Polls /api/monitor (2 s), /sys (5 s), /api/exports (3 s)
// and /api/files (10 s); /api/* goes to server.py through server.js, /sys is
// answered by server.js itself. Every text from the servers is set with
// textContent.
"use strict";

const MONITOR_MS = 2000;
const SYS_MS = 5000;
const EXPORTS_MS = 3000;
const FILES_MS = 10000;
const STAGES = [
  { key: "preprocess", label: "preprocess", color: "var(--stage-pre)" },
  { key: "inference", label: "inference", color: "var(--stage-inf)" },
  { key: "postprocess", label: "postprocess", color: "var(--stage-post)" },
];

const cards = new Map();     // model name -> card (elements kept between refreshes)
const openLogs = new Set();  // conversion ids whose log is expanded
const jobStatus = new Map(); // conversion id -> last status seen
let server = {};             // last /monitor "server" block
let sys = {};                // last /sys answer
let detailName = null;       // model shown in the detail dialog

// ===== helpers =====

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children) el.append(child);
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  for (const child of children) el.append(child);
  return el;
}

const enc = encodeURIComponent;

function errorText(data, status) {
  const detail = data && data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ");
  return `HTTP ${status}`;
}

async function request(url, method = "GET", body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data, res.status));
  return data;
}

const api = (method, path, body) => request("/api" + path, method, body);

let messageTimer;
function showMessage(text, kind = "ok") {
  const box = document.getElementById("message");
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = false;
  clearTimeout(messageTimer);
  if (kind === "ok") messageTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

async function run(action, success) {
  try {
    await action();
    if (success) showMessage(success);
    refreshMonitor();
    refreshFiles();
    refreshExports();
  } catch (err) {
    showMessage(err.message, "bad");
  }
}

const fmtMs = (v) => (v == null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const fmtNum = (v) => (v == null ? "–" : v.toLocaleString());
const fmtDate = (epoch) => new Date(epoch * 1000).toLocaleString();
const fmtTime = (epoch) => new Date(epoch * 1000).toLocaleTimeString();

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Like `free -h`: 7.3Gi, 512Mi, 0B
function fmtFree(n) {
  if (n == null) return "–";
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n}B` : `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return m ? `${m}m ${sec % 60}s` : `${sec}s`;
}

const fmtSize = (imgsz) => (Array.isArray(imgsz) ? (imgsz.length === 2 ? `${imgsz[1]} × ${imgsz[0]}` : `${imgsz[0]} × ${imgsz[0]}`) : `${imgsz} × ${imgsz}`);

// ===== system: tiles and memory =====

function setConnection(ok, detail) {
  const el = document.getElementById("conn");
  el.textContent = ok ? "connected" : "server.py not reachable";
  el.className = `conn ${ok ? "ok" : "bad"}`;
  el.title = detail || "Connection to server.py";
}

function renderTiles() {
  const tiles = [
    ["GPU", server.gpu || "none"],
    ["TensorRT", sys.tensorrt],
    ["Ultralytics", server.ultralytics],
    ["PyTorch", server.torch],
    ["Python", server.python],
    ["Uptime", server.uptime_s == null ? null : fmtDuration(server.uptime_s)],
  ];
  document.getElementById("server").replaceChildren(...tiles.map(([label, value]) =>
    h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value ?? "–") }))));
}

function renderMemory(memory) {
  const m = memory.mem;
  const bar = document.getElementById("mem-bar");
  const legend = document.getElementById("mem-legend");
  const table = document.getElementById("mem-table");
  if (m.used == null) {
    // Not Linux: only total and free are known.
    bar.replaceChildren(h("span", { class: "mem-used", style: `width:${((m.total - m.free) / m.total) * 100}%` }));
    legend.replaceChildren(h("span", { text: `${fmtFree(m.total - m.free)} of ${fmtFree(m.total)} in use` }));
    table.replaceChildren();
    return;
  }
  const pct = (v) => `${(v / m.total) * 100}%`;
  bar.replaceChildren(
    h("span", { class: "mem-used", style: `width:${pct(m.used)}`, title: `used ${fmtFree(m.used)}` }),
    h("span", { class: "mem-cache", style: `width:${pct(m.buff_cache)}`, title: `buff/cache ${fmtFree(m.buff_cache)}` }),
  );
  legend.replaceChildren(
    h("span", {}, h("i", { class: "mem-used" }), `used ${fmtFree(m.used)}`),
    h("span", {}, h("i", { class: "mem-cache" }), `buff/cache ${fmtFree(m.buff_cache)}`),
    h("span", { text: `available ${fmtFree(m.available)} of ${fmtFree(m.total)}` }),
  );
  const head = ["", "total", "used", "free", "shared", "buff/cache", "available"];
  const rows = [["Mem:", m.total, m.used, m.free, m.shared, m.buff_cache, m.available]];
  if (memory.swap) rows.push(["Swap:", memory.swap.total, memory.swap.used, memory.swap.free]);
  table.replaceChildren(
    h("thead", {}, h("tr", {}, ...head.map((t) => h("th", { text: t })))),
    h("tbody", {}, ...rows.map(([label, ...values]) =>
      h("tr", {}, h("td", { text: label }), ...values.map((v) => h("td", { text: fmtFree(v) }))))),
  );
}

// ===== charts =====

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

// One request per x position (oldest left), times under the axis.
// layers: stacked series [{key, color}]; bars: draw bars instead of areas;
// format: y-axis label; tip(point): tooltip lines.
function timeChart(box, points, { height, layers, bars = false, format, tip }) {
  box.replaceChildren();
  const width = Math.max(320, box.clientWidth);
  const pad = { l: 52, r: 14, t: 10, b: 26 };
  const w = width - pad.l - pad.r;
  const ht = height - pad.t - pad.b;
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img" });
  box.append(svg);
  const n = points.length;
  if (n < 2) {
    svg.append(s("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "empty-chart" }, "Not enough requests yet"));
    return;
  }

  const cum = points.map((p) => { let acc = 0; return layers.map((l) => (acc += p[l.key] || 0)); });
  const top = Math.max(...cum.map((c) => c[c.length - 1]), 1e-6);
  const step = niceStep(top);
  const ymax = Math.ceil(top / step) * step;
  const X = (i) => pad.l + (bars ? ((i + 0.5) * w) / n : (i * w) / (n - 1));
  const Y = (v) => pad.t + ht - (v / ymax) * ht;

  const grid = s("g", { class: "grid" });
  const axis = s("g", { class: "axis" });
  for (let v = 0; v <= ymax + step / 1000; v += step) {
    grid.append(s("line", { x1: pad.l, x2: pad.l + w, y1: Y(v), y2: Y(v) }));
    axis.append(s("text", { x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, format(v)));
  }
  const ticks = Math.min(6, n);
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k * (n - 1)) / (ticks - 1));
    const anchor = k === 0 ? "start" : k === ticks - 1 ? "end" : "middle";
    axis.append(s("text", { x: X(i), y: height - 6, "text-anchor": anchor }, fmtTime(points[i].t)));
  }
  svg.append(grid, axis);

  if (bars) {
    const bw = Math.max(1, (w / n) * 0.7);
    const g = s("g", { fill: layers[0].color });
    cum.forEach((c, i) => g.append(s("rect", { x: X(i) - bw / 2, y: Y(c[0]), width: bw, height: Y(0) - Y(c[0]) })));
    svg.append(g);
  } else {
    layers.forEach((layer, k) => {
      const upper = cum.map((c, i) => `${X(i)},${Y(c[k])}`);
      const lower = cum.map((c, i) => `${X(i)},${Y(k ? c[k - 1] : 0)}`).reverse();
      svg.append(s("polygon", { points: [...upper, ...lower].join(" "), fill: layer.color, "fill-opacity": 0.9 }));
    });
  }

  const cursor = s("line", { class: "cursor", y1: pad.t, y2: pad.t + ht, visibility: "hidden" });
  const hit = s("rect", { x: pad.l, y: pad.t, width: w, height: ht, fill: "transparent" });
  svg.append(cursor, hit);
  const tooltip = h("div", { class: "tooltip", hidden: "" });
  box.append(tooltip);

  hit.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const raw = bars ? (x - pad.l) / (w / n) - 0.5 : (x - pad.l) / (w / (n - 1));
    const i = Math.max(0, Math.min(n - 1, Math.round(raw)));
    cursor.setAttribute("x1", X(i));
    cursor.setAttribute("x2", X(i));
    cursor.setAttribute("visibility", "visible");
    tooltip.replaceChildren(h("div", { class: "sub", text: `${fmtTime(points[i].t)} · request ${i + 1} of ${n}` }), ...tip(points[i]));
    tooltip.hidden = false;
    const px = X(i) / scale;
    const left = px + 14 + tooltip.offsetWidth > rect.width ? px - 14 - tooltip.offsetWidth : px + 14;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = "6px";
  });
  hit.addEventListener("mouseleave", () => {
    cursor.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
}

function stageLegend(el, avg) {
  el.replaceChildren(...STAGES.map((st) =>
    h("span", {}, h("i", { style: `background:${st.color}` }), `${st.label} ${avg ? fmtMs(avg[st.key]) : "–"}`)));
}

// ===== model cards =====

function stat(label) {
  const value = h("span", { class: "value", text: "–" });
  return { el: h("div", { class: "stat" }, h("span", { class: "label", text: label }), value), value };
}

function createCard(name) {
  const card = { name, userWorkers: false };
  card.badge = h("span", { class: "badge" });
  card.meta = h("div", { class: "card-meta" });
  card.error = h("div", { class: "error-text", hidden: "" });
  card.requests = stat("Requests");
  card.failed = stat("Failed");
  card.perMinute = stat("Last minute");
  card.boxes = stat("Boxes / image");
  card.window = h("span");
  card.p50 = h("b");
  card.p95 = h("b");
  card.max = h("b");

  card.spark = s("svg", { class: "spark", viewBox: "0 0 100 40", preserveAspectRatio: "none" });
  card.line = s("polyline");
  card.spark.append(s("line", { class: "base", x1: 0, x2: 100, y1: 39, y2: 39 }), card.line);

  card.pre = h("span", { class: "stage-pre" });
  card.inf = h("span", { class: "stage-inf" });
  card.post = h("span", { class: "stage-post" });
  card.legend = h("div", { class: "legend" });
  card.info = h("dl", { class: "info" });

  card.workers = h("select", { onchange: () => { card.userWorkers = true; } },
    ...[1, 2, 3, 4].map((n) => h("option", { value: String(n), text: String(n) })));
  card.reload = h("button", {
    class: "secondary",
    text: "Reload",
    onclick: () => {
      const workers = Number(card.workers.value);
      card.userWorkers = false;
      run(() => api("POST", `/models/${enc(name)}/reload`, { workers }), `Reloading ${name} with ${workers} thread(s)`);
    },
  });
  card.save = h("input", {
    type: "checkbox",
    onchange: () => {
      const on = card.save.checked;
      card.userSave = true; // keep the user's tick until the server has it
      run(() => api("PATCH", `/models/${enc(name)}`, { save_images: on }),
        on ? `Saving every image sent to ${name}` : `No longer saving images sent to ${name}`)
        .finally(() => { card.userSave = false; });
    },
  });
  card.unload = h("button", {
    class: "danger",
    text: "Unload",
    onclick: () => {
      if (!confirm(`Unload ${name}? Requests for it will fail until it is loaded again.`)) return;
      run(() => api("DELETE", `/models/${enc(name)}`), `Unloaded ${name}`);
    },
  });

  card.root = h("article", { class: "card", tabindex: "0", title: `Open the full graph of ${name}` },
    h("div", { class: "card-head" }, h("h3", { text: name }), card.badge),
    card.meta,
    card.error,
    h("div", { class: "stats" }, card.requests.el, card.failed.el, card.perMinute.el, card.boxes.el),
    h("div", { class: "latency" },
      h("div", { class: "latency-line" }, card.window,
        h("span", {}, "p50 ", card.p50, "p95 ", card.p95, "max ", card.max)),
      card.spark,
      h("div", { class: "stages", title: "Average time per stage (Results.speed)" }, card.pre, card.inf, card.post),
      card.legend),
    card.info,
    h("div", { class: "actions" }, h("label", {}, "Threads", card.workers), card.reload, card.unload,
      h("label", { class: "save-toggle", title: "Pass every image sent to this model to the image server (Images page)" },
        card.save, "Save images"),
      h("span", { class: "open-hint", text: "Full graph →" })),
  );
  // Clicking the card (not its controls) opens the detail dialog.
  card.root.addEventListener("click", (event) => {
    if (!event.target.closest("button, select, label")) openDetail(name);
  });
  card.root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === card.root) openDetail(name);
  });
  return card;
}

function infoRows(i) {
  return [
    ["Task", i.task], ["Format", i.format], ["Input", i.imgsz ? fmtSize(i.imgsz) : null],
    ["Precision", i.precision], ["Device", i.device], ["Classes", i.classes],
    ["Trained", i.description], ["Exported", i.exported ? `${i.exported.slice(0, 10)} (Ultralytics ${i.exported_with})` : null],
  ].filter(([, v]) => v != null && v !== "");
}

function updateCard(card, m) {
  const st = m.stats;
  // While reloading, the old copy still answers; the new one loads behind it.
  card.badge.textContent = m.reloading ? "reloading" : m.status;
  card.badge.className = `badge ${m.reloading ? "loading" : m.status}`;
  card.reload.disabled = m.reloading;
  card.meta.textContent = `${m.file} · ${m.workers} thread(s) · queue ${m.queue}` +
    (m.save_images ? " · saving images" : "") + (m.loaded_at ? ` · loaded ${fmtDate(m.loaded_at)}` : "");
  if (!card.userSave) card.save.checked = !!m.save_images;

  const errors = [];
  if (m.error) errors.push(`Error: ${m.error}`);
  if (st.last_error) errors.push(`Last failed request: ${st.last_error}`);
  card.error.textContent = errors.join("\n");
  card.error.hidden = errors.length === 0;

  card.requests.value.textContent = fmtNum(st.requests);
  card.failed.value.textContent = fmtNum(st.failed);
  card.perMinute.value.textContent = fmtNum(st.per_minute);
  card.boxes.value.textContent = st.detections_per_image == null ? "–" : st.detections_per_image.toFixed(2);

  card.window.textContent = st.recent_ms.window ? `Last ${st.recent_ms.window} requests` : "No requests yet";
  card.p50.textContent = fmtMs(st.recent_ms.p50);
  card.p95.textContent = fmtMs(st.recent_ms.p95);
  card.max.textContent = fmtMs(st.recent_ms.max);

  const values = st.history.map((p) => p.ms);
  const top = Math.max(1, ...values);
  card.line.setAttribute("points", values.length < 2 ? "" : values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${38 - (v / top) * 34}`).join(" "));

  const avg = st.avg_ms || { preprocess: 0, inference: 0, postprocess: 0 };
  const total = avg.preprocess + avg.inference + avg.postprocess || 1;
  card.pre.style.width = `${(avg.preprocess / total) * 100}%`;
  card.inf.style.width = `${(avg.inference / total) * 100}%`;
  card.post.style.width = `${(avg.postprocess / total) * 100}%`;
  stageLegend(card.legend, st.avg_ms);

  card.info.replaceChildren(...infoRows(m.info || {}).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })]));

  if (!card.userWorkers && document.activeElement !== card.workers) card.workers.value = String(m.workers);
}

function renderModels(models) {
  const box = document.getElementById("models");
  for (const name of [...cards.keys()]) {
    if (!(name in models)) {
      cards.get(name).root.remove();
      cards.delete(name);
    }
  }
  for (const [name, m] of Object.entries(models)) {
    let card = cards.get(name);
    if (!card) {
      card = createCard(name);
      cards.set(name, card);
      box.append(card.root);
    }
    updateCard(card, m);
  }
  document.getElementById("no-models").hidden = cards.size > 0;
}

// ===== model detail dialog =====

const detail = document.getElementById("detail");

function openDetail(name) {
  detailName = name;
  document.getElementById("detail-name").textContent = name;
  document.getElementById("detail-chart").replaceChildren();
  document.getElementById("detail-boxes").replaceChildren();
  detail.showModal();
  refreshDetail();
}

detail.addEventListener("close", () => { detailName = null; });

async function refreshDetail() {
  if (!detailName) return;
  const name = detailName;
  try {
    const m = await api("GET", `/monitor/${enc(name)}`);
    if (detailName === name) renderDetail(m);
  } catch (err) {
    document.getElementById("detail-foot").textContent = err.message;
  }
}

function renderDetail(m) {
  const st = m.stats;
  const badge = document.getElementById("detail-badge");
  badge.textContent = m.reloading ? "reloading" : m.status;
  badge.className = `badge ${m.reloading ? "loading" : m.status}`;
  const info = m.info || {};
  document.getElementById("detail-meta").textContent = [
    m.file, `${m.workers} thread(s)`, info.imgsz ? `input ${fmtSize(info.imgsz)}` : null,
    info.precision, info.classes ? `${info.classes} classes` : null,
  ].filter(Boolean).join(" · ");

  const avg = st.avg_ms || {};
  const items = [
    ["Requests", fmtNum(st.requests)], ["Failed", fmtNum(st.failed)], ["Last minute", fmtNum(st.per_minute)],
    ["p50", fmtMs(st.recent_ms.p50)], ["p95", fmtMs(st.recent_ms.p95)], ["Max", fmtMs(st.recent_ms.max)],
    ["Boxes / image", st.detections_per_image == null ? "–" : st.detections_per_image.toFixed(2)],
    ["Avg inference", fmtMs(avg.inference)],
  ];
  document.getElementById("detail-stats").replaceChildren(...items.map(([label, value]) =>
    h("div", { class: "stat" }, h("span", { class: "label", text: label }), h("span", { class: "value", text: value }))));
  stageLegend(document.getElementById("detail-legend"), st.avg_ms);

  // A chart under the mouse is left alone, so its tooltip stays readable.
  const chart = document.getElementById("detail-chart");
  if (!chart.matches(":hover")) {
    timeChart(chart, st.history, {
      height: 300,
      layers: STAGES,
      format: (v) => `${Math.round(v * 10) / 10} ms`,
      tip: (p) => [
        h("div", {}, "total ", h("b", { text: fmtMs(p.ms) })),
        ...STAGES.map((stg) => h("div", {}, h("i", { style: `display:inline-block;width:8px;height:8px;margin-right:5px;background:${stg.color}` }),
          `${stg.label} `, h("b", { text: fmtMs(p[stg.key]) }))),
        h("div", { text: `${p.detections} box(es)` }),
      ],
    });
  }
  const boxes = document.getElementById("detail-boxes");
  if (!boxes.matches(":hover")) {
    timeChart(boxes, st.history, {
      height: 130,
      bars: true,
      layers: [{ key: "detections", color: "var(--rec-green-dark)" }],
      format: (v) => String(Math.round(v * 10) / 10),
      tip: (p) => [h("div", {}, h("b", { text: String(p.detections) }), " box(es) · ", fmtMs(p.ms))],
    });
  }
  document.getElementById("detail-foot").textContent =
    `Last ${st.history.length} requests (the server keeps up to 600). Statistics restart when the model is reloaded.`;
}

window.addEventListener("resize", () => { if (detailName) refreshDetail(); });

// ===== files and conversions =====

const convert = document.getElementById("convert");
const convertForm = document.getElementById("convert-form");

function openConvert(file) {
  convertForm.dataset.file = file;
  document.getElementById("convert-file").textContent = file;
  convertForm.output.value = file.replace(/\.pt$/i, "") + ".engine";
  convertForm.overwrite.checked = false;
  convert.showModal();
}

convertForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const height = Number(convertForm.height.value);
  const width = Number(convertForm.width.value);
  const body = {
    file: convertForm.dataset.file,
    output: convertForm.output.value.trim(),
    imgsz: height === width ? height : [height, width],
    half: convertForm.half.checked,
    overwrite: convertForm.overwrite.checked,
  };
  convert.close();
  run(() => api("POST", "/exports", body), `Converting ${body.file} to ${body.output} (${width} × ${height})`);
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

function renderFiles(files) {
  document.getElementById("files").replaceChildren(...files.map((f) => {
    const used = f.used_by.length > 0;
    const buttons = [];
    if (/\.pt$/i.test(f.name)) {
      buttons.push(h("button", { class: "secondary small", text: "Convert to TensorRT", onclick: () => openConvert(f.name) }));
    }
    const del = h("button", {
      class: "danger small",
      text: "Delete",
      title: used ? "Unload the models that use it first" : `Delete ${f.name}`,
      onclick: () => {
        if (!confirm(`Delete ${f.name} from the Jetson? This cannot be undone.`)) return;
        run(() => api("DELETE", `/files/${enc(f.name)}`), `Deleted ${f.name}`);
      },
    });
    del.disabled = used;
    buttons.push(del);
    return h("tr", {},
      h("td", {}, h("code", { text: f.name })),
      h("td", { class: "num", text: fmtBytes(f.size) }),
      h("td", { text: fmtDate(f.modified) }),
      h("td", { text: used ? f.used_by.join(", ") : "–" }),
      h("td", { class: "buttons" }, ...buttons));
  }));

  const select = document.getElementById("load-file");
  const keep = select.value;
  select.replaceChildren(...files.map((f) => h("option", { value: f.name, text: f.name })));
  if (files.some((f) => f.name === keep)) select.value = keep;
}

function renderExports(jobs) {
  const now = Date.now() / 1000;
  for (const job of jobs) {
    const before = jobStatus.get(job.id);
    if (before && before !== job.status) {
      if (job.status === "done") {
        showMessage(`Converted ${job.file} to ${job.output}`);
        refreshFiles();
      } else if (job.status === "failed") {
        showMessage(`Conversion of ${job.file} failed: ${job.error}`, "bad");
      }
    }
    jobStatus.set(job.id, job.status);
  }

  document.getElementById("exports").replaceChildren(...jobs.map((job) => {
    const time = job.status === "queued" ? "waiting"
      : !job.started ? "not started"
        : job.finished ? `took ${fmtDuration(job.finished - job.started)}`
          : `running for ${fmtDuration(now - job.started)}`;
    const log = h("details", { ontoggle: (e) => (e.target.open ? openLogs.add(job.id) : openLogs.delete(job.id)) },
      h("summary", { text: `Log (${job.log.length} lines)` }),
      h("pre", { text: job.log.join("\n") || "(no output yet)" }));
    if (openLogs.has(job.id)) log.open = true;
    const cancel = ["queued", "running"].includes(job.status)
      ? h("button", {
        class: "danger small",
        text: "Cancel",
        onclick: () => run(() => api("DELETE", `/exports/${enc(job.id)}`), `Cancelled the conversion of ${job.file}`),
      })
      : "";
    return h("div", { class: "job" },
      h("div", { class: "job-head" }, h("b", { text: `${job.file} → ${job.output}` }), h("span", { class: `badge ${job.status}`, text: job.status })),
      h("div", { class: "job-meta", text: `input ${fmtSize(job.imgsz)} · ${job.half ? "FP16" : "FP32"} · ${time}` }),
      job.error ? h("div", { class: "error-text", text: job.error }) : "",
      log,
      cancel);
  }));
  document.getElementById("no-exports").hidden = jobs.length > 0;
}

// ===== forms =====

document.getElementById("load-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const nameInput = form.elements.namedItem("name"); // form.name is the form's own name
  const body = { name: nameInput.value.trim(), file: form.file.value, workers: Number(form.workers.value) };
  run(async () => {
    await api("POST", "/models", body);
    nameInput.value = "";
  }, `Loading ${body.name} from ${body.file}`);
});

document.getElementById("upload-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const file = form.file.files[0];
  if (!file) return;
  const data = new FormData();
  data.append("file", file);
  data.append("overwrite", form.overwrite.checked ? "true" : "false");

  // XMLHttpRequest instead of fetch: it reports upload progress.
  const progress = document.getElementById("upload-progress");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/files");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress.value = (e.loaded / e.total) * 100; };
  xhr.onloadend = () => {
    progress.hidden = true;
    let reply = {};
    try { reply = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      showMessage(`Uploaded ${reply.file} (${fmtBytes(reply.size)})`);
      form.reset();
      refreshFiles();
    } else {
      showMessage(xhr.status ? errorText(reply, xhr.status) : "Upload failed: no connection", "bad");
    }
  };
  progress.value = 0;
  progress.hidden = false;
  xhr.send(data);
});

// ===== polling =====

async function refreshMonitor() {
  try {
    const data = await api("GET", "/monitor");
    setConnection(true);
    server = data.server;
    renderTiles();
    renderModels(data.models);
  } catch (err) {
    setConnection(false, err.message);
  }
  refreshDetail();
}

async function refreshSys() {
  try {
    sys = await request("/sys");
    renderTiles();
    renderMemory(sys.memory);
  } catch {
    // the dashboard server itself is down; the page cannot do anything about it
  }
}

async function refreshFiles() {
  try {
    renderFiles((await api("GET", "/files")).files);
  } catch {
    // the connection badge already reports it
  }
}

async function refreshExports() {
  try {
    renderExports((await api("GET", "/exports")).exports);
  } catch {
    // the connection badge already reports it
  }
}

refreshMonitor();
refreshSys();
refreshFiles();
refreshExports();
setInterval(refreshMonitor, MONITOR_MS);
setInterval(refreshSys, SYS_MS);
setInterval(refreshExports, EXPORTS_MS);
setInterval(refreshFiles, FILES_MS);
