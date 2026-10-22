// Images page: the image server address and per-model save switches (both
// kept by server.py, /api/...), and the saved images (image server,
// /images-api/..., reached through server.js): filter, select, delete and
// download them as a zip, like a Roboflow dataset. Every text from the
// servers is set with textContent.
"use strict";

const PAGE = 48;          // images per "Load more"
const SETTINGS_MS = 3000; // address, counters, switches
const STATS_MS = 5000;    // store size, filter choices
const GALLERY_MS = 10000; // new images, while only the first page is shown

const items = [];          // records shown, in gallery order
const selected = new Set(); // ids chosen for delete / download (also off-screen ones)
let nextCursor = null;     // continue the list from here ("Load more")
let total = 0;             // images the filters match
let lastClicked = -1;      // index of the last checkbox clicked, for Shift-click ranges
let viewing = -1;          // index in `items` open in the viewer
let addressEdited = false;

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

const $ = (id) => document.getElementById(id);
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

let messageTimer;
function showMessage(text, kind = "ok") {
  const box = $("message");
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = false;
  clearTimeout(messageTimer);
  if (kind === "ok") messageTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

function fmtBytes(n) {
  if (n == null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const fmtNum = (v) => (v == null ? "–" : v.toLocaleString());
const fmtDate = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString() : "–");
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;
const boxesText = (n) => (n === 1 ? "1 box" : `${fmtNum(n)} boxes`);

function stat(label, value) {
  return h("div", { class: "stat" }, h("span", { class: "label", text: label }), h("span", { class: "value", text: value }));
}

// Same colour per class as the SDK's Draw()
const classColor = (id) => `rgb(${(id * 199) % 255}, ${(id * 131) % 255}, ${(id * 67) % 255})`;

// ===== saving: address, counters, switches =====

async function refreshSettings() {
  let settings;
  try {
    settings = await request("/api/settings");
  } catch (err) {
    $("save-error").textContent = `server.py: ${err.message}`;
    $("save-error").hidden = false;
    return;
  }
  const input = $("image-server");
  if (!addressEdited && document.activeElement !== input) input.value = settings.image_server.replace(/^http:\/\//, "");
  $("save-stats").replaceChildren(
    stat("Saved", fmtNum(settings.saved)),
    stat("Not saved", fmtNum(settings.failed)),
    stat("Waiting", fmtNum(settings.queued)),
  );
  $("save-error").textContent = settings.last_error ? `Last error: ${settings.last_error}` : "";
  $("save-error").hidden = !settings.last_error;

  try {
    renderSwitches((await request("/api/models")).models);
  } catch {
    // shown by the error line above on the next round
  }
}

function renderSwitches(models) {
  const box = $("save-models");
  const names = Object.keys(models);
  if (!names.length) {
    box.replaceChildren(h("span", { class: "sub", text: "No models loaded" }));
    return;
  }
  box.replaceChildren(...names.map((name) => {
    const input = h("input", { type: "checkbox", onchange: () => saveSwitch(name, input.checked) });
    input.checked = !!models[name].save_images;
    return h("label", { class: "toggle" }, input, h("b", { text: name }), h("span", { class: "sub", text: models[name].file }));
  }));
}

async function saveSwitch(name, on) {
  try {
    await request(`/api/models/${enc(name)}`, "PATCH", { save_images: on });
    showMessage(on ? `Saving every image sent to ${name}` : `No longer saving images sent to ${name}`);
  } catch (err) {
    showMessage(err.message, "bad");
  }
  refreshSettings();
}

$("image-server").addEventListener("input", () => { addressEdited = true; });

$("server-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const settings = await request("/api/settings", "PUT", { image_server: $("image-server").value.trim() });
    addressEdited = false;
    showMessage(`Images are now saved to ${settings.image_server}`);
  } catch (err) {
    showMessage(err.message, "bad");
  }
  refreshSettings();
  setTimeout(() => { refreshStore(); loadImages(true); }, 3500); // the dashboard follows within 3 s
});

// ===== image store: totals and the filter choices =====

function setConnection(ok, detail) {
  $("conn").textContent = ok ? "image server connected" : "image server not reachable";
  $("conn").className = `conn ${ok ? "ok" : "bad"}`;
  $("conn").title = detail || "";
  $("server-state").textContent = ok ? "reachable" : "not reachable";
  $("server-state").className = `pill ${ok ? "ok" : "bad"}`;
  $("server-state").title = detail || "";
}

function fillSelect(select, first, entries) {
  const keep = select.value;
  select.replaceChildren(h("option", { value: "", text: first }),
    ...entries.map(([value, n]) => h("option", { value, text: `${value || "(no model)"} (${fmtNum(n)})` })));
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

async function refreshStore() {
  let stats;
  try {
    stats = await request("/images-api/stats");
    setConnection(true);
  } catch (err) {
    setConnection(false, err.message);
    $("store-stats").replaceChildren();
    $("store-hint").textContent = err.message;
    return;
  }
  $("store-stats").replaceChildren(
    stat("Images", fmtNum(stats.count)),
    stat("Size", fmtBytes(stats.bytes)),
    stat("Disk free", fmtBytes(stats.disk.free)),
    stat("Newest", stats.newest ? new Date(stats.newest * 1000).toLocaleTimeString() : "–"),
  );
  $("store-hint").textContent =
    `Kept in ${stats.data_dir}. Up to ${fmtNum(stats.limits.max_images)} images; the oldest go first, ` +
    `also while less than ${fmtBytes(stats.limits.min_free_bytes)} of disk is free.`;
  fillSelect($("f-model"), "All models", Object.entries(stats.per_model));
  fillSelect($("f-class"), "All classes", Object.entries(stats.per_class));
  const boxes = $("f-boxes");
  boxes.options[1].textContent = `With boxes (${fmtNum(stats.count - stats.without_boxes)})`;
  boxes.options[2].textContent = `Without boxes (${fmtNum(stats.without_boxes)})`;
}

// ===== filters =====

function filterParams() {
  const params = new URLSearchParams();
  const day = (value) => new Date(`${value}T00:00:00`).getTime() / 1000; // local midnight
  if ($("f-model").value) params.set("model", $("f-model").value);
  if ($("f-class").value) params.set("cls", $("f-class").value);
  if ($("f-boxes").value !== "any") params.set("boxes", $("f-boxes").value);
  if ($("f-since").value) params.set("since", String(day($("f-since").value)));
  if ($("f-until").value) params.set("until", String(day($("f-until").value) + 86400)); // the whole "To" day
  if ($("f-q").value.trim()) params.set("q", $("f-q").value.trim());
  return params;
}

for (const id of ["f-model", "f-class", "f-boxes", "f-since", "f-until", "f-sort"]) {
  $(id).addEventListener("change", () => loadImages(true));
}
let searchTimer;
$("f-q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadImages(true), 350);
});
$("filters").addEventListener("submit", (event) => { event.preventDefault(); loadImages(true); });
$("f-reset").addEventListener("click", () => {
  $("filters").reset();
  loadImages(true);
});

// ===== gallery =====

function thumbCard(rec, index) {
  const check = h("input", { type: "checkbox", title: "Select (Shift-click: select a range)" });
  check.checked = selected.has(rec.id);
  check.addEventListener("click", (event) => {
    if (event.shiftKey && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
      for (const r of items.slice(a, b + 1)) check.checked ? selected.add(r.id) : selected.delete(r.id);
    } else {
      check.checked ? selected.add(rec.id) : selected.delete(rec.id);
    }
    lastClicked = index;
    syncSelection();
  });

  const card = h("div", { class: `thumb${selected.has(rec.id) ? " selected" : ""}` },
    h("label", { class: "thumb-check" }, check),
    h("button", { class: "thumb-open", type: "button", title: `Open · ${rec.model} · ${fmtDate(rec.created)}`,
      onclick: () => openViewer(index) },
      h("img", { src: `/images-api/images/${enc(rec.id)}/thumb`, alt: "", loading: "lazy" }),
      h("span", { class: "thumb-caption" },
        h("b", { text: rec.model || "–" }),
        h("span", { class: rec.boxes ? "boxes" : "sub", text: boxesText(rec.boxes) })),
      h("span", { class: "thumb-time", text: new Date(rec.created * 1000).toLocaleString() })));
  card.dataset.id = rec.id;
  return card;
}

async function loadImages(reset) {
  const params = filterParams();
  params.set("limit", String(PAGE));
  params.set("sort", $("f-sort").value);
  if (!reset && nextCursor != null) params.set("cursor", String(nextCursor));
  let page;
  try {
    page = await request(`/images-api/images?${params}`);
  } catch {
    if (reset) {
      items.length = 0;
      $("gallery").replaceChildren();
    }
    $("more").hidden = true;
    return;
  }
  if (reset) {
    items.length = 0;
    lastClicked = -1;
  }
  const start = items.length;
  items.push(...page.images);
  const cards = page.images.map((rec, i) => thumbCard(rec, start + i));
  if (reset) $("gallery").replaceChildren(...cards);
  else $("gallery").append(...cards);
  nextCursor = page.next;
  total = page.total;
  $("more").hidden = page.next == null;
  $("more").textContent = `Load more (${fmtNum(items.length)} of ${fmtNum(total)})`;
  $("no-images").hidden = items.length > 0;
  $("match-count").textContent = `${plural(total, "image")} match` + (items.length < total ? `, ${fmtNum(items.length)} shown` : "");
  syncSelection();
}

$("more").addEventListener("click", () => loadImages(false));

// ===== selection =====

function syncSelection() {
  for (const card of $("gallery").children) {
    const on = selected.has(card.dataset.id);
    card.classList.toggle("selected", on);
    card.querySelector("input").checked = on;
  }
  const n = selected.size;
  $("selected-count").textContent = `${fmtNum(n)} selected`;
  $("clear-selection").hidden = n === 0;
  $("download").disabled = n === 0;
  $("delete-selected").disabled = n === 0;
  $("download").textContent = n ? `Download ${fmtNum(n)}` : "Download";
  $("delete-selected").textContent = n ? `Delete ${fmtNum(n)}` : "Delete";
  const shown = items.length > 0 && items.every((r) => selected.has(r.id));
  $("select-page").checked = shown;
  $("select-page").indeterminate = !shown && items.some((r) => selected.has(r.id));
  $("select-all").textContent = `Select all ${fmtNum(total)} matching`;
  $("select-all").disabled = total === 0;
  $("export-conf-label").hidden = $("export-format").value !== "yolo";
  if (viewing >= 0 && items[viewing]) $("viewer-selected").checked = selected.has(items[viewing].id);
}

$("select-page").addEventListener("change", (event) => {
  for (const r of items) event.target.checked ? selected.add(r.id) : selected.delete(r.id);
  syncSelection();
});

$("select-all").addEventListener("click", async () => {
  try {
    const { ids } = await request(`/images-api/images/ids?${filterParams()}`);
    for (const id of ids) selected.add(id);
    syncSelection();
  } catch (err) {
    showMessage(err.message, "bad");
  }
});

$("clear-selection").addEventListener("click", () => {
  selected.clear();
  syncSelection();
});

$("export-format").addEventListener("change", syncSelection);

$("download").addEventListener("click", () => {
  // A form post: the browser saves the zip itself, however big it is.
  const form = $("export-form");
  form.elements.ids.value = [...selected].join(",");
  form.elements.format.value = $("export-format").value;
  form.elements.min_conf.value = $("export-conf").value || "0";
  form.submit();
  showMessage(`Preparing a zip of ${plural(selected.size, "image")}; your browser saves it when it is ready`);
});

async function deleteIds(ids) {
  await request("/images-api/images/delete", "POST", { ids });
  for (const id of ids) selected.delete(id);
}

$("delete-selected").addEventListener("click", async () => {
  const n = selected.size;
  if (!confirm(`Delete ${plural(n, "image")} from the image server? This cannot be undone.`)) return;
  try {
    await deleteIds([...selected]);
    showMessage(`Deleted ${plural(n, "image")}`);
  } catch (err) {
    showMessage(err.message, "bad");
  }
  refreshStore();
  loadImages(true);
});

// ===== viewer =====

const viewer = $("viewer");

function openViewer(index) {
  const rec = items[index];
  if (!rec) return;
  viewing = index;
  $("viewer-title").textContent = rec.model || "Image";
  $("viewer-meta").textContent = `${fmtDate(rec.created)} · ${rec.id} · ${index + 1} of ${fmtNum(total)}`;
  $("viewer-prev").disabled = index === 0;
  $("viewer-next").disabled = index === items.length - 1 && nextCursor == null;
  $("viewer-selected").checked = selected.has(rec.id);
  const fileUrl = `/images-api/images/${enc(rec.id)}/file`;
  $("viewer-download").href = fileUrl;
  $("viewer-download").setAttribute("download", `${rec.id}.jpg`);

  const meta = rec.meta || {};
  const timing = meta.timing_ms || {};
  const rows = [
    ["Size", `${rec.width} × ${rec.height} px · ${fmtBytes(rec.size)}`],
    ["Boxes", String(rec.boxes)],
    ["conf / iou", meta.conf != null ? `${meta.conf} / ${meta.iou}` : null],
    ["Server time", timing.total_server != null ? `${timing.total_server} ms (inference ${timing.inference_call} ms)` : null],
    ["From", meta.source],
  ].filter(([, v]) => v != null);
  $("viewer-info").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));

  const names = rec.names || {};
  $("viewer-boxes").replaceChildren(...(rec.detections.length ? rec.detections.map((d) => {
    const [x1, y1, x2, y2, score, cls] = d;
    const id = Math.round(cls);
    return h("tr", {},
      h("td", {}, h("i", { class: "swatch", style: `background:${classColor(id)}` }), names[id] ?? String(id)),
      h("td", { class: "num", text: score.toFixed(2) }),
      h("td", { text: `${Math.round(x1)}, ${Math.round(y1)}, ${Math.round(x2 - x1)}, ${Math.round(y2 - y1)}` }));
  }) : [h("tr", {}, h("td", { colspan: "3", class: "sub", text: "No boxes" }))]));

  const canvas = $("viewer-canvas");
  const image = new Image();
  image.onload = () => {
    if (items[viewing] !== rec) return; // moved on meanwhile
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const line = Math.max(2, Math.round(image.naturalWidth / 400));
    ctx.font = `${Math.max(12, line * 7)}px system-ui, sans-serif`;
    for (const [x1, y1, x2, y2, score, cls] of rec.detections) {
      const id = Math.round(cls);
      const label = `${names[id] ?? id} ${score.toFixed(2)}`;
      ctx.strokeStyle = ctx.fillStyle = classColor(id);
      ctx.lineWidth = line;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const tw = ctx.measureText(label).width + 8;
      const th = Math.max(16, line * 9);
      const ty = y1 - th < 0 ? y1 : y1 - th;
      ctx.fillRect(x1, ty, tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x1 + 4, ty + th - line * 2.5);
    }
  };
  image.src = fileUrl;
  if (!viewer.open) viewer.showModal();
}

async function step(delta) {
  const target = viewing + delta;
  if (target < 0) return;
  if (target >= items.length && nextCursor != null) await loadImages(false);
  if (target < items.length) openViewer(target);
}

$("viewer-prev").addEventListener("click", () => step(-1));
$("viewer-next").addEventListener("click", () => step(1));
viewer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});

$("viewer-selected").addEventListener("change", (event) => {
  const rec = items[viewing];
  if (!rec) return;
  event.target.checked ? selected.add(rec.id) : selected.delete(rec.id);
  syncSelection();
});

$("viewer-delete").addEventListener("click", async () => {
  const rec = items[viewing];
  if (!rec || !confirm("Delete this image from the image server? This cannot be undone.")) return;
  try {
    await deleteIds([rec.id]);
    showMessage("Image deleted");
    viewer.close();
    refreshStore();
    loadImages(true);
  } catch (err) {
    showMessage(err.message, "bad");
  }
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
viewer.addEventListener("close", () => { viewing = -1; });

// ===== polling =====

refreshSettings();
refreshStore().then(() => loadImages(true));
setInterval(refreshSettings, SETTINGS_MS);
setInterval(refreshStore, STATS_MS);
// New images appear by themselves, except while you page further, select or look at one
setInterval(() => { if (items.length <= PAGE && !viewer.open && selected.size === 0) loadImages(true); }, GALLERY_MS);
