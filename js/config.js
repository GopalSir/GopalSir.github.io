/** Network endpoints and reference display geometry (matches Python client). */
export const TUNNEL_URL = 'wss://robot.anantlibrary.in';
export const CAMERA_WS_URL = 'wss://camera.anantlibrary.in';
export const CAMERA2_WS_URL = 'wss://camera2.anantlibrary.in';

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
