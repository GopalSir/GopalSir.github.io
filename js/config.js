/** Network endpoints and reference display geometry (matches Python client). */
export const APP_DEBUG_VERSION = 'perf-v6-webrtc-fix1';

export const TUNNEL_URL = 'wss://robot.anantlibrary.in';
export const CAMERA_WS_URL = 'wss://camera.anantlibrary.in';
export const CAMERA2_WS_URL = 'wss://camera2.anantlibrary.in';

/**
 * ICE servers for WebRTC camera streams.
 * STUN helps for local/public discovery; for reliable remote access across NAT
 * you should append your TURN server credentials here.
 */
export const CAMERA_ICE_SERVERS = [
  {
    urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  },
];

export const REF_WIDTH = 1920;
export const REF_HEIGHT = 1080;

/** Absolute URL so MediaPipe fetch works from any deploy path. */
export const HAND_MODEL_PATH = new URL(
  '../assets/hand_landmarker.task',
  import.meta.url
).href;
export const MEDIAPIPE_WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

/** Modes that show camera 1 vs camera 2 (req 4.6). */
export const CAM1_MODES = new Set(['YZ Plane', 'Yaw/Pitch', 'IDLE']);
export const CAM2_MODES = new Set(['X Axis', 'Roll']);

export function cameraIndexForMode(mode) {
  return CAM2_MODES.has(mode) ? 2 : 1;
}
