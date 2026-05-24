"""
Dual-camera WebSocket broadcaster with realtime frame handling.

Optimizations vs. legacy:
  - V4L2 buffer = 1 + dedicated reader threads (latest-frame-wins, no V4L2 backlog).
  - Per-client backpressure: drop frames for clients whose send buffer is behind.
  - Binary JPEG WebSocket frames by default (no base64+JSON wrapper, ~33% less bytes).
  - Pause/resume protocol: server only encodes for cameras a client is viewing.
  - JPEG encode runs in asyncio.to_thread so the event loop stays responsive.
  - Default 720p @ q70 -> ~3-4x smaller frames vs. 1080p @ q85.

Wire protocol (server -> client):
  - Default mode  : raw JPEG bytes per WebSocket message (binaryType='arraybuffer').
  - --legacy-text : '{"type":"frame","data":"<base64>"}' for older clients.

Wire protocol (client -> server):
  - '{"type":"pause"}'  -> stop sending frames to this client (still encoded if any
                          other client wants them; saved end-to-end CPU + bandwidth).
  - '{"type":"resume"}' -> resume sending frames to this client.
  - Default state on connect is 'resume' (active).
"""
import asyncio
import argparse
import base64
import json
import threading
import time

import cv2
import websockets


# ──────────────────────────────────────────────
# Camera helpers
# ──────────────────────────────────────────────

def _jpeg_encode(frame, quality):
    """Run on a worker thread via asyncio.to_thread."""
    ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    return buf.tobytes()


def open_camera(device, width=1280, height=720, fps=30):
    """V4L2 + MJPG. Buffer size pinned to 1 so reader threads always see fresh frames."""
    cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    try:
        # Critical: without this V4L2 keeps a 4-frame queue and you read stale frames.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera: {device}")
    return cap


def log_camera_resolution(log_fn, cap, label, device):
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    log_fn(f"[CAM] Camera {label} ({device}) driver reports: {w}x{h}")


class FrameHolder:
    """Thread-safe latest-frame container. Older frames are silently overwritten."""
    __slots__ = ('lock', 'frame', 'ts')

    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.ts = 0.0

    def set(self, frame):
        with self.lock:
            self.frame = frame
            self.ts = time.monotonic()

    def snapshot(self):
        with self.lock:
            return self.frame, self.ts


def reader_loop(cap, holder, stop_event, label, log_fn):
    """Continuously drain the V4L2 buffer and overwrite the latest frame."""
    log_fn(f"[CAM] Reader thread {label} started")
    consecutive_failures = 0
    while not stop_event.is_set():
        ok, frame = cap.read()
        if ok:
            holder.set(frame)
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures % 100 == 1:
                log_fn(f"[CAM] Reader {label} read failure (#{consecutive_failures})")
            time.sleep(0.01)
    log_fn(f"[CAM] Reader thread {label} stopped")


class ClientState:
    """Per-connection state: WebSocket + active flag (pause/resume)."""
    __slots__ = ('ws', 'active')

    def __init__(self, ws):
        self.ws = ws
        self.active = True


# ──────────────────────────────────────────────
# Server
# ──────────────────────────────────────────────

class CameraServer:
    def __init__(self, args):
        self.port_a = args.port_a
        self.port_b = args.port_b
        self.delay = 1.0 / args.fps
        self.quality = args.quality
        self.binary = not args.legacy_text
        self.max_buffer_bytes = args.max_buffer_bytes
        self.send_timeout = args.send_timeout

        self.log(
            f"[INIT] Opening cameras at {args.width}x{args.height} MJPG "
            f"(capture_fps={args.capture_fps}, broadcast_fps={args.fps})"
        )
        self.cap_a = open_camera(args.device_a, args.width, args.height, args.capture_fps)
        self.cap_b = open_camera(args.device_b, args.width, args.height, args.capture_fps)
        log_camera_resolution(self.log, self.cap_a, "A", args.device_a)
        log_camera_resolution(self.log, self.cap_b, "B", args.device_b)

        self.holder_a = FrameHolder()
        self.holder_b = FrameHolder()
        self.stop_event = threading.Event()
        self.thread_a = threading.Thread(
            target=reader_loop,
            args=(self.cap_a, self.holder_a, self.stop_event, "A", self.log),
            daemon=True,
            name="cam-a-reader",
        )
        self.thread_b = threading.Thread(
            target=reader_loop,
            args=(self.cap_b, self.holder_b, self.stop_event, "B", self.log),
            daemon=True,
            name="cam-b-reader",
        )
        self.thread_a.start()
        self.thread_b.start()

        self.clients_a: dict = {}  # ws -> ClientState
        self.clients_b: dict = {}
        self.last_ts_a = 0.0
        self.last_ts_b = 0.0

        # Lightweight stats for periodic logging.
        self._sent_a = 0
        self._sent_b = 0
        self._dropped_a = 0
        self._dropped_b = 0
        self._stats_last_log = time.monotonic()

    def log(self, msg):
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    async def encode(self, frame):
        return await asyncio.to_thread(_jpeg_encode, frame, self.quality)

    @staticmethod
    def _write_buffer_size(ws):
        try:
            return ws.transport.get_write_buffer_size()
        except Exception:
            return 0

    async def _send_to_client(self, state, payload, drop_counter_label):
        """Send to a single client; drop the frame if the client is behind."""
        ws = state.ws
        if self._write_buffer_size(ws) > self.max_buffer_bytes:
            if drop_counter_label == 'A':
                self._dropped_a += 1
            else:
                self._dropped_b += 1
            return False
        try:
            await asyncio.wait_for(ws.send(payload), timeout=self.send_timeout)
            return True
        except asyncio.TimeoutError:
            if drop_counter_label == 'A':
                self._dropped_a += 1
            else:
                self._dropped_b += 1
            return False
        except websockets.ConnectionClosed:
            return False
        except Exception:
            return False

    def _wrap_text(self, jpeg_bytes):
        return json.dumps({
            "type": "frame",
            "data": base64.b64encode(jpeg_bytes).decode('utf-8'),
        })

    async def _broadcast_camera(self, holder, clients, label):
        """Encode + send the latest frame to all *active* clients of one camera."""
        active_states = [s for s in clients.values() if s.active]
        if not active_states:
            return

        frame, ts = holder.snapshot()
        if frame is None:
            return

        last_ts = self.last_ts_a if label == 'A' else self.last_ts_b
        if ts <= last_ts:
            return  # No new frame since last broadcast; skip.
        if label == 'A':
            self.last_ts_a = ts
        else:
            self.last_ts_b = ts

        jpeg_bytes = await self.encode(frame)
        if jpeg_bytes is None:
            return

        payload = jpeg_bytes if self.binary else self._wrap_text(jpeg_bytes)
        results = await asyncio.gather(
            *[self._send_to_client(s, payload, label) for s in active_states],
            return_exceptions=True,
        )
        sent_count = sum(1 for r in results if r is True)
        if label == 'A':
            self._sent_a += sent_count
        else:
            self._sent_b += sent_count

    def _maybe_log_stats(self):
        now = time.monotonic()
        if now - self._stats_last_log < 5.0:
            return
        elapsed = now - self._stats_last_log
        self._stats_last_log = now
        a_active = sum(1 for s in self.clients_a.values() if s.active)
        b_active = sum(1 for s in self.clients_b.values() if s.active)
        a_fps = self._sent_a / max(1, len(self.clients_a)) / elapsed if self.clients_a else 0
        b_fps = self._sent_b / max(1, len(self.clients_b)) / elapsed if self.clients_b else 0
        self.log(
            f"[STAT] A: clients={len(self.clients_a)} active={a_active} "
            f"sent_fps≈{a_fps:.1f} dropped={self._dropped_a} | "
            f"B: clients={len(self.clients_b)} active={b_active} "
            f"sent_fps≈{b_fps:.1f} dropped={self._dropped_b}"
        )
        self._sent_a = self._sent_b = 0
        self._dropped_a = self._dropped_b = 0

    async def frame_broadcaster(self):
        # Let reader threads fill at least one frame before we start.
        await asyncio.sleep(0.5)
        self.log(
            f"[INIT] Broadcaster started "
            f"(binary={self.binary}, max_buffer_bytes={self.max_buffer_bytes}, "
            f"send_timeout={self.send_timeout}s)"
        )
        while True:
            t0 = time.time()
            await asyncio.gather(
                self._broadcast_camera(self.holder_a, self.clients_a, 'A'),
                self._broadcast_camera(self.holder_b, self.clients_b, 'B'),
                return_exceptions=True,
            )
            self._maybe_log_stats()
            elapsed = time.time() - t0
            await asyncio.sleep(max(0, self.delay - elapsed))

    async def _handle_client_message(self, state, message, label):
        """Process pause/resume commands from a client."""
        if not isinstance(message, str):
            return
        try:
            cmd = json.loads(message)
        except json.JSONDecodeError:
            return
        t = cmd.get('type')
        if t == 'pause' and state.active:
            state.active = False
            self.log(f"[WS] Client paused (cam-{label}): {state.ws.remote_address}")
        elif t == 'resume' and not state.active:
            state.active = True
            self.log(f"[WS] Client resumed (cam-{label}): {state.ws.remote_address}")

    async def _handler(self, websocket, label):
        clients = self.clients_a if label == 'A' else self.clients_b
        state = ClientState(websocket)
        clients[websocket] = state
        self.log(f"[WS] Client connected (cam-{label}): {websocket.remote_address}")
        try:
            async for message in websocket:
                await self._handle_client_message(state, message, label)
        except websockets.ConnectionClosed:
            pass
        finally:
            clients.pop(websocket, None)
            self.log(f"[WS] Client disconnected (cam-{label})")

    async def handler_a(self, websocket):
        await self._handler(websocket, 'A')

    async def handler_b(self, websocket):
        await self._handler(websocket, 'B')

    async def start(self):
        self.log(f"[INIT] Camera A  ->  ws://0.0.0.0:{self.port_a}")
        self.log(f"[INIT] Camera B  ->  ws://0.0.0.0:{self.port_b}")
        self.log(f"[INIT] Stream FPS={1/self.delay:.0f}  JPEG quality={self.quality}")

        async with (
            websockets.serve(self.handler_a, "0.0.0.0", self.port_a),
            websockets.serve(self.handler_b, "0.0.0.0", self.port_b),
        ):
            await self.frame_broadcaster()


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Dual-camera WebSocket server (latest-frame-wins, binary JPEG).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port-a", type=int, default=8001,
                        help="Port for camera A (existing tunnel ingress)")
    parser.add_argument("--port-b", type=int, default=8002,
                        help="Port for camera B (second tunnel ingress)")
    parser.add_argument("--fps", type=int, default=20,
                        help="WebSocket broadcast frame rate")
    parser.add_argument("--capture-fps", type=int, default=30,
                        help="V4L2 capture frame rate (hardware MJPG mode)")
    parser.add_argument("--quality", type=int, default=70,
                        help="Outbound JPEG quality (1-100)")
    parser.add_argument("--width", type=int, default=1280,
                        help="Capture width for both cameras (MJPG)")
    parser.add_argument("--height", type=int, default=720,
                        help="Capture height for both cameras (MJPG)")
    parser.add_argument("--device-a", type=str, default="/dev/video0",
                        help="Device for camera A")
    parser.add_argument("--device-b", type=str, default="/dev/video3",
                        help="Device for camera B")
    parser.add_argument("--legacy-text", action="store_true",
                        help="Send base64+JSON text frames (older clients only)")
    parser.add_argument("--max-buffer-bytes", type=int, default=1_000_000,
                        help="Drop frame if a client's TCP send buffer exceeds this")
    parser.add_argument("--send-timeout", type=float, default=0.1,
                        help="Per-client send timeout in seconds (drop if exceeded)")
    args = parser.parse_args()

    for attr in ("device_a", "device_b"):
        val = getattr(args, attr)
        if val.lstrip('-').isdigit():
            setattr(args, attr, int(val))

    server = CameraServer(args)
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\n[EXIT] Releasing cameras ...")
        server.stop_event.set()
        # Give reader threads a moment to exit cleanly.
        time.sleep(0.05)
        server.cap_a.release()
        server.cap_b.release()
