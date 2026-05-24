"""
Dual-camera WebRTC server with WebSocket signaling.

This replaces MJPEG-over-WebSocket with native WebRTC video tracks:
  - Better decode performance on Android (hardware codec pipeline).
  - Preserves latest-frame-wins capture via dedicated reader threads.
  - Keeps pause/resume semantics per camera stream.

Signaling protocol (JSON over ws:// camera ports):
  client -> server:
    {"type":"offer","sdp":"..."}
    {"type":"pause"}
    {"type":"resume"}
    {"type":"ping"}

  server -> client:
    {"type":"ready","camera":"A"|"B"}
    {"type":"answer","sdp":"..."}
    {"type":"pong"}

Notes:
  - This server intentionally uses non-trickle ICE (offer/answer SDP only).
  - For off-LAN reliability you will need TURN in the browser ICE config.
"""

import argparse
import asyncio
import json
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

import cv2
import numpy as np
import websockets

try:
    from aiortc import (
        RTCPeerConnection,
        RTCSessionDescription,
        VideoStreamTrack,
        RTCConfiguration,
        RTCIceServer,
    )
    from av import VideoFrame
except Exception as exc:  # pragma: no cover (runtime dependency guard)
    raise SystemExit(
        "Missing WebRTC dependencies. Install on Pi with: pip install aiortc av"
    ) from exc


def open_camera(device, width=1280, height=720, fps=30):
    """Open V4L2 capture in MJPG mode with minimal driver buffering."""
    cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera: {device}")
    return cap


class FrameHolder:
    """Thread-safe latest frame slot."""

    __slots__ = ("lock", "frame", "ts")

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
    """Continuously drain camera frames so we always keep the freshest one."""
    log_fn(f"[CAM] Reader thread {label} started")
    misses = 0
    while not stop_event.is_set():
        ok, frame = cap.read()
        if ok:
            holder.set(frame)
            misses = 0
        else:
            misses += 1
            if misses % 100 == 1:
                log_fn(f"[CAM] Reader {label} read failure (#{misses})")
            time.sleep(0.01)
    log_fn(f"[CAM] Reader thread {label} stopped")


async def _await_if_needed(value):
    if asyncio.iscoroutine(value):
        await value


class LatestFrameVideoTrack(VideoStreamTrack):
    """
    WebRTC VideoStreamTrack backed by a latest-frame holder.

    This track paces output at target_fps and emits the freshest capture frame.
    Captured frames are resized to ``rtc_width x rtc_height`` before encoding so
    the Pi's software VP8/H264 encoder stays well under saturation.

    pause/resume is implemented as a flag on the track instead of teardown so
    the underlying RTP sender + encoder stay attached. This avoids leaving one
    peer connection stuck after a pause→resume cycle.
    """

    IDLE_INTERVAL_S = 1.0  # while paused, emit a heartbeat frame once a second

    def __init__(
        self,
        holder: FrameHolder,
        rtc_width: int,
        rtc_height: int,
        target_fps: int,
    ):
        super().__init__()
        self.holder = holder
        self.rtc_width = max(1, int(rtc_width))
        self.rtc_height = max(1, int(rtc_height))
        self.target_fps = max(1, int(target_fps))
        self.interval_s = 1.0 / float(self.target_fps)
        self.next_deadline = time.perf_counter()
        self.last_frame = np.zeros((self.rtc_height, self.rtc_width, 3), dtype=np.uint8)
        self.paused = False
        self.frames_sent = 0

    def _resize_if_needed(self, frame):
        h, w = frame.shape[:2]
        if w == self.rtc_width and h == self.rtc_height:
            return frame
        return cv2.resize(
            frame,
            (self.rtc_width, self.rtc_height),
            interpolation=cv2.INTER_AREA,
        )

    async def recv(self):
        now = time.perf_counter()
        sleep_for = self.next_deadline - now
        if sleep_for > 0:
            await asyncio.sleep(sleep_for)

        interval = self.IDLE_INTERVAL_S if self.paused else self.interval_s
        self.next_deadline = max(
            self.next_deadline + interval,
            time.perf_counter(),
        )

        if not self.paused:
            frame, _ = self.holder.snapshot()
            if frame is not None:
                self.last_frame = self._resize_if_needed(frame)

        video = VideoFrame.from_ndarray(self.last_frame, format="bgr24")
        pts, time_base = await self.next_timestamp()
        video.pts = pts
        video.time_base = time_base
        self.frames_sent += 1
        return video


@dataclass
class ClientSession:
    ws: object
    label: str
    active: bool = True
    pc: Optional[RTCPeerConnection] = None
    sender: Optional[object] = None
    track: Optional[LatestFrameVideoTrack] = None
    ice_done: Optional[asyncio.Event] = None


class CameraServer:
    def __init__(self, args):
        self.port_a = args.port_a
        self.port_b = args.port_b
        self.capture_fps = args.capture_fps
        self.stream_fps = args.fps
        self.width = args.width
        self.height = args.height
        # Encoded WebRTC frame size (defaults smaller than capture so the Pi's
        # software encoder doesn't saturate). Capture stays at width x height.
        self.rtc_width = max(1, int(getattr(args, "rtc_width", 640) or 640))
        self.rtc_height = max(1, int(getattr(args, "rtc_height", 360) or 360))

        ice_servers = []
        for url in args.stun_url:
            if url:
                ice_servers.append(RTCIceServer(urls=url))
        if args.turn_url:
            ice_servers.append(
                RTCIceServer(
                    urls=args.turn_url,
                    username=args.turn_username or "",
                    credential=args.turn_password or "",
                )
            )
        self.rtc_configuration = RTCConfiguration(iceServers=ice_servers)
        self.rtc_ice_urls = [url for url in args.stun_url if url]
        if args.turn_url:
            self.rtc_ice_urls.append(args.turn_url)

        self.log(
            f"[INIT] Opening cameras at {self.width}x{self.height} "
            f"(capture_fps={self.capture_fps}, stream_fps={self.stream_fps})"
        )

        self.cap_a = open_camera(args.device_a, self.width, self.height, self.capture_fps)
        self.cap_b = open_camera(args.device_b, self.width, self.height, self.capture_fps)

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

        self.sessions_a: Dict[object, ClientSession] = {}
        self.sessions_b: Dict[object, ClientSession] = {}

        # Compatibility flags accepted from the old script; not used by WebRTC path.
        self.ignored_quality = args.quality
        self.ignored_legacy_text = args.legacy_text
        self.ignored_max_buffer_bytes = args.max_buffer_bytes
        self.ignored_send_timeout = args.send_timeout

    def log(self, msg):
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    @staticmethod
    async def _send_json(ws, payload):
        try:
            await ws.send(json.dumps(payload))
        except Exception:
            pass

    def _holder_for_label(self, label):
        return self.holder_a if label == "A" else self.holder_b

    def _sessions_for_label(self, label):
        return self.sessions_a if label == "A" else self.sessions_b

    def _new_track(self, label):
        holder = self._holder_for_label(label)
        return LatestFrameVideoTrack(
            holder,
            rtc_width=self.rtc_width,
            rtc_height=self.rtc_height,
            target_fps=self.stream_fps,
        )

    async def _wait_for_ice(self, session: ClientSession, timeout_s=5.0):
        pc = session.pc
        if not pc:
            return
        if pc.iceGatheringState == "complete":
            return
        if not session.ice_done:
            return
        try:
            await asyncio.wait_for(session.ice_done.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            self.log(f"[WS] ICE gather timeout (cam-{session.label}), sending answer anyway")

    async def _close_peer(self, session: ClientSession, reason=""):
        pc = session.pc
        track = session.track

        session.pc = None
        session.sender = None
        session.track = None
        session.ice_done = None

        if track:
            try:
                track.stop()
            except Exception:
                pass

        if pc:
            try:
                await _await_if_needed(pc.close())
            except Exception:
                pass

        if reason:
            self.log(f"[WS] Closed peer (cam-{session.label}): {reason}")

    async def _set_session_active(self, session: ClientSession, active: bool):
        """
        Toggle pause/resume by flipping a flag on the track itself.

        Avoids replaceTrack(None)/replaceTrack(new) churn that previously left
        one peer connection stuck after a pause→resume cycle (cam1 freeze).
        """
        changed = session.active != active
        session.active = active

        if session.track is not None:
            session.track.paused = not active

        if changed:
            action = "resumed" if active else "paused"
            who = getattr(session.ws, "remote_address", "?")
            self.log(f"[WS] Client {action} (cam-{session.label}): {who}")

    async def _handle_offer(self, session: ClientSession, sdp: str):
        if not sdp:
            await self._send_json(session.ws, {"type": "error", "message": "Missing offer SDP"})
            return

        await self._close_peer(session, reason="renegotiate")

        pc = RTCPeerConnection(self.rtc_configuration)
        session.pc = pc
        session.ice_done = asyncio.Event()

        @pc.on("icegatheringstatechange")
        async def on_ice_gathering_state_change():
            # Ignore stale callbacks after session renegotiation/cleanup.
            if session.pc is not pc:
                return
            if pc.iceGatheringState == "complete" and session.ice_done:
                session.ice_done.set()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if session.pc is not pc:
                return
            state = pc.connectionState
            self.log(f"[WS] Peer state (cam-{session.label}): {state}")
            if state in ("failed", "closed"):
                await self._close_peer(session, reason=f"state={state}")

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
            session.track = self._new_track(session.label)
            session.sender = pc.addTrack(session.track)

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await self._wait_for_ice(session)

            # If client already requested pause before the offer completed,
            # carry that state forward into the freshly created track.
            if session.track is not None and not session.active:
                session.track.paused = True

            await self._send_json(
                session.ws,
                {
                    "type": "answer",
                    "sdp": pc.localDescription.sdp if pc.localDescription else answer.sdp,
                },
            )

        except Exception as exc:
            self.log(f"[WS] Offer handling failed (cam-{session.label}): {exc}")
            await self._send_json(session.ws, {"type": "error", "message": str(exc)})
            await self._close_peer(session, reason="offer-failed")

    async def _handle_client_message(self, session: ClientSession, message: str):
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            return

        msg_type = payload.get("type")

        if msg_type == "offer":
            await self._handle_offer(session, payload.get("sdp", ""))
        elif msg_type == "pause":
            await self._set_session_active(session, False)
        elif msg_type == "resume":
            await self._set_session_active(session, True)
        elif msg_type == "ping":
            await self._send_json(session.ws, {"type": "pong"})
        elif msg_type == "candidate":
            # Non-trickle mode: candidates are bundled in SDP offer/answer.
            pass
        else:
            self.log(f"[WS] Unknown message type (cam-{session.label}): {msg_type}")

    async def _handler(self, websocket, label):
        sessions = self._sessions_for_label(label)
        session = ClientSession(ws=websocket, label=label)
        sessions[websocket] = session

        self.log(f"[WS] Client connected (cam-{label}): {websocket.remote_address}")
        await self._send_json(websocket, {"type": "ready", "camera": label})

        try:
            async for message in websocket:
                if isinstance(message, str):
                    await self._handle_client_message(session, message)
        except websockets.ConnectionClosed:
            pass
        finally:
            sessions.pop(websocket, None)
            await self._close_peer(session, reason="client-disconnect")
            self.log(f"[WS] Client disconnected (cam-{label})")

    async def handler_a(self, websocket):
        await self._handler(websocket, "A")

    async def handler_b(self, websocket):
        await self._handler(websocket, "B")

    async def stats_loop(self):
        last_sent = {"A": 0, "B": 0}
        while True:
            await asyncio.sleep(5.0)
            a_clients = len(self.sessions_a)
            b_clients = len(self.sessions_b)
            a_active = sum(1 for s in self.sessions_a.values() if s.active)
            b_active = sum(1 for s in self.sessions_b.values() if s.active)

            # Sum frames_sent across all sessions per camera so we can see if
            # the encoder is making progress at all.
            a_total = sum(
                (s.track.frames_sent if s.track else 0)
                for s in self.sessions_a.values()
            )
            b_total = sum(
                (s.track.frames_sent if s.track else 0)
                for s in self.sessions_b.values()
            )
            a_fps = (a_total - last_sent["A"]) / 5.0
            b_fps = (b_total - last_sent["B"]) / 5.0
            last_sent["A"] = a_total
            last_sent["B"] = b_total

            self.log(
                f"[STAT] cam-A clients={a_clients} active={a_active} "
                f"enc_fps≈{a_fps:.1f} | "
                f"cam-B clients={b_clients} active={b_active} "
                f"enc_fps≈{b_fps:.1f}"
            )

    async def start(self):
        self.log(f"[INIT] Camera A signaling -> ws://0.0.0.0:{self.port_a}")
        self.log(f"[INIT] Camera B signaling -> ws://0.0.0.0:{self.port_b}")
        self.log(
            f"[INIT] WebRTC encode={self.rtc_width}x{self.rtc_height} "
            f"fps={self.stream_fps} (capture {self.width}x{self.height})"
        )
        self.log(f"[INIT] ICE servers: {', '.join(self.rtc_ice_urls) if self.rtc_ice_urls else '(none)'}")
        self.log(
            "[INIT] Ignoring legacy JPEG args: "
            f"quality={self.ignored_quality}, legacy_text={self.ignored_legacy_text}, "
            f"max_buffer_bytes={self.ignored_max_buffer_bytes}, send_timeout={self.ignored_send_timeout}"
        )

        async with (
            websockets.serve(self.handler_a, "0.0.0.0", self.port_a),
            websockets.serve(self.handler_b, "0.0.0.0", self.port_b),
        ):
            await asyncio.gather(self.stats_loop(), asyncio.Future())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Dual-camera WebRTC server with WebSocket signaling.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port-a", type=int, default=8001,
                        help="Signaling port for camera A")
    parser.add_argument("--port-b", type=int, default=8002,
                        help="Signaling port for camera B")
    parser.add_argument("--fps", type=int, default=15,
                        help="Target WebRTC video send fps (encoder pacing)")
    parser.add_argument("--rtc-width", type=int, default=640,
                        help="Encoded frame width (capture is downscaled to this before encode)")
    parser.add_argument("--rtc-height", type=int, default=360,
                        help="Encoded frame height (capture is downscaled to this before encode)")
    parser.add_argument("--capture-fps", type=int, default=30,
                        help="V4L2 capture frame rate")
    parser.add_argument("--quality", type=int, default=70,
                        help="Legacy JPEG arg (ignored, kept for script compatibility)")
    parser.add_argument("--width", type=int, default=1280,
                        help="Capture width for both cameras")
    parser.add_argument("--height", type=int, default=720,
                        help="Capture height for both cameras")
    parser.add_argument("--device-a", type=str, default="/dev/video0",
                        help="Device for camera A")
    parser.add_argument("--device-b", type=str, default="/dev/video3",
                        help="Device for camera B")
    parser.add_argument("--legacy-text", action="store_true",
                        help="Legacy JPEG flag (ignored)")
    parser.add_argument("--max-buffer-bytes", type=int, default=1_000_000,
                        help="Legacy JPEG flag (ignored)")
    parser.add_argument("--send-timeout", type=float, default=0.1,
                        help="Legacy JPEG flag (ignored)")
    parser.add_argument(
        "--stun-url",
        action="append",
        default=["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
        help="ICE STUN server URL (repeatable)",
    )
    parser.add_argument(
        "--turn-url",
        type=str,
        default="",
        help="ICE TURN URL (e.g. turn:turn.example.com:3478?transport=udp)",
    )
    parser.add_argument(
        "--turn-username",
        type=str,
        default="",
        help="TURN username",
    )
    parser.add_argument(
        "--turn-password",
        type=str,
        default="",
        help="TURN credential/password",
    )
    args = parser.parse_args()

    for attr in ("device_a", "device_b"):
        val = getattr(args, attr)
        if isinstance(val, str) and val.lstrip("-").isdigit():
            setattr(args, attr, int(val))

    server = CameraServer(args)
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\n[EXIT] Releasing cameras ...")
        server.stop_event.set()
        time.sleep(0.05)
        server.cap_a.release()
        server.cap_b.release()
