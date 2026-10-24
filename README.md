# yoloinferencewebserver

The web dashboard of the YOLO inference server on an NVIDIA Jetson: monitoring, model management, TensorRT
conversion and saved images, in the browser. A small Node.js (Express) server serves two pages and forwards their
requests to the inference server and the image server.

![Models page](docs/models-page.jpg)

It is one of four repositories that work together:

| Repository | What it is | Runs on | Port |
| --- | --- | --- | --- |
| [yoloinferencemodel](https://github.com/CaptainAAI/yoloinferencemodel) | Inference server `server.py` | Jetson | 6767 |
| **yoloinferencewebserver** (this one) | Web dashboard | Jetson | 8080 |
| [yoloinferenceimageserver](https://github.com/CaptainAAI/yoloinferenceimageserver) | Image store | Jetson, local only | 6770 |
| [yoloinferencesdkcpp](https://github.com/CaptainAAI/yoloinferencesdkcpp) | C++ SDK for Windows programs | Windows PC | none |

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running it by hand](#running-it-by-hand)
- [Configuration](#configuration)
- [Models page](#models-page)
- [Images page](#images-page)
- [How it works](#how-it-works)
- [Files](#files)
- [deploy.sh](#deploysh)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 18 or newer and npm (tested: Node 24 on a Jetson Orin). One dependency: `express`. `deploy.sh` installs
  Node.js and npm with apt when they are missing or too old, and `express` with npm.
- [yoloinferencemodel](https://github.com/CaptainAAI/yoloinferencemodel) running on the same Jetson (port 6767).
- Optional: [yoloinferenceimageserver](https://github.com/CaptainAAI/yoloinferenceimageserver) for the Images page.
- `free` (procps) and Python with `tensorrt` for the memory panel and the TensorRT version; both are on a Jetson.

## Quick start

On the Jetson:

```bash
git clone https://github.com/CaptainAAI/yoloinferencewebserver.git
cd yoloinferencewebserver
bash deploy.sh
```

Run it as your normal user (not with `sudo`); it asks for your sudo password once. It installs what is missing,
copies the dashboard to `~/yoloinferenceweb`, runs `npm install`, and installs and starts the systemd service
`yolo-dashboard`, which also starts at every boot and restarts after a crash.

Then open `http://<jetson-address>:8080`, e.g. `http://140.129.7.180:8080`. `deploy.sh` prints every address the
Jetson has, and whether `server.py` and the image server are reachable.

To update later: `git pull && bash deploy.sh`. Every command of the script is in [deploy.sh](#deploysh).

## Running it by hand

For development. On the Jetson, stop the service first (`bash deploy.sh stop`), since both use port 8080.

```bash
npm install
npm start                                                   # http://0.0.0.0:8080 -> server.py on 127.0.0.1:6767
PORT=8081 YOLO_API=http://127.0.0.1:6767 npm start          # other port / server
```

For development on a PC, point it at the Jetson: `YOLO_API=http://140.129.7.180:6767 npm start`, then open
`http://localhost:8080`. The Images page then only works with an image server reachable from the PC.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8080 | Port of the dashboard (3000 is used by another app on the Jetson) |
| `YOLO_API` | `http://127.0.0.1:6767` | Address of `server.py` |
| `IMAGE_API` | `http://127.0.0.1:6770` | Image server address, used only while `server.py` cannot be asked; normally the address comes from `server.py`'s settings |
| `PYTHON` | `python3` | Python used to read the TensorRT version |

## Models page

`index.html` + `app.js`, refreshed every 2 s.

| Area | What you see and do |
| --- | --- |
| System | GPU, TensorRT, Ultralytics, PyTorch and Python versions, uptime |
| Memory | The Jetson's memory as `free -h` shows it, with a bar |
| Model cards | Status (ready, loading, reloading, error), file, threads, queue, requests, failures, last minute, boxes per image, p50 / p95 / max, a sparkline, the average time per stage, the model's info (task, format, input size, precision, device, classes, training data, export date). **Threads** + **Reload**, **Unload**, **Save images** |
| Full graph | Click a card: the last 600 requests' time, stacked by stage (preprocess, inference, postprocess), and boxes per request, with a tooltip per request |
| Load a model | Name, file, threads. The name is what clients send as `model_name` |
| TensorRT conversions | Status, duration and log of each conversion; Cancel |
| Model files | List, upload (`.engine`, `.pt`, `.onnx`, with progress), delete, **Convert to TensorRT** for `.pt` files (output name, height × width, FP16) |

![Full graph](docs/full-graph.png)

Every model figure comes from Ultralytics through `server.py`. The memory and the TensorRT version are read by this
dashboard server (`GET /sys`), because `server.py` reports Ultralytics figures only.

## Images page

`images.html` + `images.js`. Needs the image server.

| Area | What you see and do |
| --- | --- |
| Saving images | The image server address (text field, saved in `server.py`), whether it is reachable, saved / not saved / waiting counters, a **Save images** switch per model |
| Image store | Image count, size, free disk, newest image |
| Filters | Model, class, with / without boxes, date from / to, id search, newest or oldest first; the page shows how many images match |
| Selection | A checkbox on each image (Shift-click selects a range), **Select shown**, **Select all matching** (also images not loaded yet) |
| Download | **Download N** as a zip: **YOLO dataset** (`images/`, `labels/`, `data.yaml`, ready for `yolo train data=data.yaml`; **Min score** leaves weak boxes out) or **Images only** |
| Delete | **Delete N** removes the selected images |
| Viewer | Click an image: the boxes drawn on it, a box table, Download, Delete, Selected; ‹ › or the arrow keys step through the images. **Boxes** and **Labels** switch the boxes and the class-name tags on or off (keys B and L; remembered in the browser), so nothing covers the area around an object. Tags are see-through and sit above the box, or below it at the top edge. Hovering a row of the box table shows that one box with its name |

## How it works

`server.js` serves `public/` and forwards requests unchanged (streamed, so uploads and zips are not held in memory):

| Path | Goes to |
| --- | --- |
| `/api/*` | `server.py` (`/api/monitor` → `http://127.0.0.1:6767/monitor`) |
| `/images-api/*` | The image server at the address set in `server.py` (read every 3 s) |
| `/sys` | Answered here: `free -b` and `import tensorrt` |

When a server is down, the dashboard answers 502 `{"detail": "... not reachable at ..."}` and the page shows it.
The pages are plain HTML, CSS and JavaScript (no framework, no build step); every text from the servers is set with
`textContent`.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | The Express server: static files, proxies, `/sys` |
| `package.json`, `package-lock.json` | npm package, dependency `express` |
| `public/index.html`, `public/app.js` | Models page |
| `public/images.html`, `public/images.js` | Images page |
| `public/style.css`, `public/logo.png` | REC theme (green `#008838`, yellow `#f8b800`), light and dark mode |
| `deploy.sh` | Installs the dashboard on the Jetson as the systemd service `yolo-dashboard`, and manages it |

## deploy.sh

`deploy.sh` installs the dashboard as the systemd service `yolo-dashboard` and manages it. Run it on the Jetson, from
the clone, as your normal user; it refuses to run as root and asks for sudo itself when it needs it.

| Command | What it does | sudo |
| --- | --- | --- |
| `bash deploy.sh` (or `install`) | Install or update everything, then (re)start the service: the six steps below | yes |
| `bash deploy.sh check` | Only checks the requirements and which installed files differ; installs and changes nothing. Exit code 1 when something is missing | no |
| `bash deploy.sh status` | Service state, start time, start at boot, pid, memory, automatic restarts, log size, installed commit, settings; who holds port 8080; every address of the dashboard, whether `server.py` and the image server are reachable, the TensorRT version and memory; the last 8 log lines | no |
| `bash deploy.sh logs [N]` | The last N log lines (default 50); `logs -f` follows the log | no |
| `bash deploy.sh start`, `stop`, `restart` | Controls the service; `start` and `restart` wait until it answers | yes |
| `bash deploy.sh unit` | Prints the systemd unit file it installs | no |
| `bash deploy.sh uninstall` | Stops, disables and removes the service; the files stay | yes |
| `bash deploy.sh help` | The usage text from the top of the script | no |

`install`, step by step:

| Step | What happens |
| --- | --- |
| 1. Requirements | Asks for sudo once. Installs with apt what is missing: `curl`, and `nodejs` + `npm` when Node.js is missing or older than 18. Checks `free` (memory panel) and whether `python3` can read the TensorRT version |
| 2. Files and npm dependencies | Lists the files that changed, copies `package.json`, `package-lock.json`, `server.js` and `public/` to `WEB_DIR`, runs `npm install --omit=dev` there and checks that `express` is installed. Writes `.deployed` (commit and date) and remembers the settings |
| 3. Service | Writes `/etc/systemd/system/yolo-dashboard.service` (prints the diff when it changes), reloads systemd and enables the service for every boot |
| 4. Start | Stops a copy of the dashboard started by hand (for example with `nohup npm start`) that holds the port, then restarts the service |
| 5. Wait | Polls `http://127.0.0.1:8080/` for up to 30 s. If the service crashes meanwhile, it prints the new log lines and stops |
| 6. Report | The output of `bash deploy.sh status` |

The service runs `node server.js` as your user in `WEB_DIR`, with `PORT`, `YOLO_API` and `NODE_ENV=production` set; it
starts after the network (and after `yolo-inference` and `yolo-images` when installed), restarts 5 s after a crash,
and appends its output to `web.log`. See it with `bash deploy.sh unit`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `WEB_DIR` | `~/yoloinferenceweb` | Folder the dashboard runs in |
| `WEB_PORT` | 8080 | Port (3000 is used by another app on the Jetson) |
| `INFER_PORT` | 6767 | Port of `server.py` on this Jetson |

Example: `WEB_PORT=8081 bash deploy.sh`. A setting given once is remembered in
`~/.config/yolo-deploy/yolo-dashboard.env` and used by every later run.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The page does not open | `bash deploy.sh status` and `bash deploy.sh logs`; check the port and the firewall |
| `deploy.sh`: *sudo needs your password but there is no terminal* | Run it in a terminal on the Jetson, or over `ssh -t` |
| Badge says *server.py not reachable* | Deploy or start [yoloinferencemodel](https://github.com/CaptainAAI/yoloinferencemodel) |
| Images page says *image server not reachable* | Deploy [yoloinferenceimageserver](https://github.com/CaptainAAI/yoloinferenceimageserver), check the address on the page |
| TensorRT shows `–` | `python3 -c "import tensorrt"` fails for the user running the dashboard; set `PYTHON` |
| Port 8080 in use | `WEB_PORT=8081 bash deploy.sh` |

**Security:** there is no login. Anyone who can open the dashboard can unload models and delete files and images.
Keep it on a trusted network.
