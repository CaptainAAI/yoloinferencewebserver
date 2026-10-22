// Web dashboard for the YOLO server (server.py).
//
// Serves the pages in public/ and forwards requests unchanged, so the pages
// need no CORS and uploads stream straight through:
//   /api/*         -> server.py      (/api/monitor -> http://127.0.0.1:6767/monitor)
//   /images-api/*  -> image server   (/images-api/images -> http://127.0.0.1:6770/images)
// The image server listens on the Jetson only; this proxy is how the Images
// page reaches it from other machines. Its address is the one set in server.py
// (GET /settings, "image_server", edited on the Images page), so the page
// shows the same store that server.py saves to.
//
// /sys reports what server.py does not: the Jetson's memory (`free -b`) and the
// installed TensorRT version. server.py takes its monitoring figures from
// Ultralytics only, so these system figures are read here instead.
//
// Environment:
//   PORT      port of this dashboard, default 8080 (3000 is taken by another app on the Jetson)
//   YOLO_API  address of server.py, default http://127.0.0.1:6767
//   IMAGE_API image server address while server.py is unreachable, default http://127.0.0.1:6770
//   PYTHON    Python used to read the TensorRT version, default python3

import express from "express";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PORT = Number(process.env.PORT ?? 8080);
const YOLO_API = new URL(process.env.YOLO_API ?? "http://127.0.0.1:6767");
const IMAGE_API = new URL(process.env.IMAGE_API ?? "http://127.0.0.1:6770");
const PYTHON = process.env.PYTHON ?? "python3";
const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

const app = express();
app.disable("x-powered-by");

// Mounted on a prefix, so req.url is already the target's path ("/monitor").
function proxyTo(target, name) {
  return (req, res) => {
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      res.status(502).json({ detail: `${name} not reachable at ${target.origin}: ${err.message}` });
    });
    req.pipe(upstream);
  };
}

app.use("/api", proxyTo(YOLO_API, "YOLO server"));

// The image server address from server.py's settings, read at most every 3 s.
let imageTarget = IMAGE_API;
let imageTargetRead = 0;
async function currentImageTarget() {
  if (Date.now() - imageTargetRead > 3000) {
    imageTargetRead = Date.now();
    try {
      const settings = await (await fetch(new URL("/settings", YOLO_API))).json();
      imageTarget = new URL(settings.image_server);
    } catch {
      // server.py down or answering something else: keep the last address
    }
  }
  return imageTarget;
}

app.use("/images-api", async (req, res) => proxyTo(await currentImageTarget(), "Image server")(req, res));

// `free -b`: the same table as `free -h`, in bytes, formatted by the page.
//                total        used        free      shared  buff/cache   available
// Mem:      7848542208  3452813312  ...
// Swap:              0           0           0
async function memory() {
  try {
    const { stdout } = await run("free", ["-b"]);
    const rows = {};
    for (const line of stdout.split("\n")) {
      const [label, ...values] = line.trim().split(/\s+/);
      if (label === "Mem:" || label === "Swap:") rows[label.slice(0, -1).toLowerCase()] = values.map(Number);
    }
    const [total, used, free, shared, buffCache, available] = rows.mem;
    return {
      source: "free -b",
      mem: { total, used, free, shared, buff_cache: buffCache, available },
      swap: rows.swap ? { total: rows.swap[0], used: rows.swap[1], free: rows.swap[2] } : null,
    };
  } catch {
    // No `free` (e.g. testing on Windows): total and free from Node only.
    return { source: "os", mem: { total: os.totalmem(), free: os.freemem() }, swap: null };
  }
}

// Read once: the installed TensorRT does not change while the dashboard runs.
const tensorrt = run(PYTHON, ["-c", "import tensorrt; print(tensorrt.__version__)"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => null);

app.get("/sys", async (req, res) => {
  res.json({ hostname: os.hostname(), tensorrt: await tensorrt, memory: await memory() });
});

app.use(express.static(path.join(here, "public")));

app.listen(PORT, () => {
  console.log(`YOLO dashboard on http://0.0.0.0:${PORT} -> ${YOLO_API.origin}`);
});
