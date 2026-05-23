# Lite 6 — Android tablet web cockpit

Browser-based port of [`bimanual_pi_client2_camera.py`](../bimanual_pi_client2_camera.py) for HTTPS-hosted use on an Android tablet.

## Features

- Dual robot camera WebSockets (always connected); **one stream on screen** by mode (Camera 1: YZ Plane / Yaw-Pitch / IDLE; Camera 2: X Axis / Roll)
- Front-camera hand tracking (MediaPipe) with small PIP preview
- Same gesture math, velocity mapping, hand-eye transform, HUD, and mode gizmo as the Python client
- Touch toolbar: Connect, E-Stop, Record episode, Fullscreen, Exit
- Episode export: `.webm` video + `.json` metadata (`recordStartTime`, `recordEndTime`, `totalTimeSec`)

## Quick start (local HTTPS test)

From this directory:

```bash
# Python 3
python -m http.server 8080
```

For camera access on a tablet you **must** use HTTPS (not plain HTTP except `localhost`). Deploy the folder behind nginx/Caddy on your domain, e.g. `https://your-host/bimanual_android_web/`.

### Required asset

`assets/hand_landmarker.task` — copied from the parent `bimanual/` folder. If missing, download from [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).

## Deploy (production)

1. Copy the entire `bimanual_android_web/` tree to your TLS web root.
2. Ensure MIME types: `.task` → `application/octet-stream`, `.js` → `application/javascript`.
3. Open in Chrome on the tablet; allow **camera** when prompted.
4. Tap **Start** on the overlay (required on tablet for camera permission).
5. Tap **Connect** to arm the robot WebSocket (`wss://robot.anantlibrary.in`).
6. Use **Calib** panel to tune roll/pitch/yaw (same as `r/R/p/P/y/Y` keys in Python).

**Stuck on loading?** You must use **HTTPS**, tap **Start**, and allow camera access. Errors appear on the overlay if init fails.

## Endpoints (config in `js/config.js`)

| Service | URL |
|---------|-----|
| Robot | `wss://robot.anantlibrary.in` |
| Camera 1 | `wss://camera.anantlibrary.in` |
| Camera 2 | `wss://camera2.anantlibrary.in` |

## Parity checklist

1. **Modes** — Left hand finger poses: 1 finger → YZ Plane (cam1), 2 → X Axis (cam2), 3 → Yaw/Pitch (cam1), 4 → Roll (cam2).
2. **Clutch** — Right hand visible unlocks motion; green deadzone when active, red when locked.
3. **Motion** — Robot moves in expected directions per mode; tune Calib if axes are off.
4. **Gripper** — Right thumb up closes; flat opens, then stop after ~1.2 s.
5. **E-Stop** — Hold toggles zero velocity and IDLE.
6. **Record** — Downloads `episode_*.webm` and `episode_*.json` with correct timestamps.
7. **Layout** — Rotate tablet; HUD scales with canvas; Fullscreen hides browser UI.

## File layout

```
index.html          UI shell
css/cockpit.css     Responsive fullscreen layout
js/main.js          Main loop
js/robot-math.js    Gesture & velocity math (Python parity)
js/gestures.js      MediaPipe + front camera
js/ws-camera.js     Dual remote streams
js/ws-robot.js      Robot commands
js/hud.js / gizmo.js Overlays
js/compositor.js    Single-stream display
js/recorder.js      Episode capture
assets/hand_landmarker.task
```
