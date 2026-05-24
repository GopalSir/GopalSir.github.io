/**
 * Front-camera capture + MediaPipe HandLandmarker.
 */

import {
  HAND_MODEL_PATH,
  MEDIAPIPE_WASM_BASE,
  REF_WIDTH,
  REF_HEIGHT,
} from './config.js';

const INIT_TIMEOUT_MS = 45000;
const DETECT_MAX_WIDTH = 640;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms
      );
    }),
  ]);
}

export function createGestureTracker() {
  let landmarker = null;
  let videoEl = null;
  let stream = null;
  let detectCanvas = null;
  let detectCtx = null;
  let lastTimestamp = 0;
  let ready = false;
  let error = null;

  async function init(onProgress) {
    const progress = (msg) => {
      if (onProgress) onProgress(msg);
    };

    progress('Loading MediaPipe…');
    const { FilesetResolver, HandLandmarker } = await withTimeout(
      import('@mediapipe/tasks-vision'),
      30000,
      'MediaPipe library load'
    );

    progress('Loading WASM…');
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE),
      30000,
      'MediaPipe WASM load'
    );

    progress('Loading hand model…');
    const baseOpts = { modelAssetPath: HAND_MODEL_PATH };
    try {
      landmarker = await withTimeout(
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { ...baseOpts, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        }),
        INIT_TIMEOUT_MS,
        'Hand landmarker (GPU)'
      );
    } catch (_) {
      landmarker = await withTimeout(
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { ...baseOpts, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        }),
        INIT_TIMEOUT_MS,
        'Hand landmarker (CPU)'
      );
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Camera API unavailable. Open this page over HTTPS (not file://).'
      );
    }

    progress('Opening front camera…');
    videoEl = document.createElement('video');
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    videoEl.autoplay = true;

    stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: REF_WIDTH },
          height: { ideal: REF_HEIGHT },
        },
        audio: false,
      }),
      20000,
      'Camera permission'
    );

    videoEl.srcObject = stream;
    await videoEl.play();

    detectCanvas = document.createElement('canvas');
    detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

    ready = true;
    error = null;
  }

  function detectForVideo(tsMs) {
    if (!ready || !landmarker || videoEl.readyState < 2) {
      return null;
    }
    const vw = videoEl.videoWidth || REF_WIDTH;
    const vh = videoEl.videoHeight || REF_HEIGHT;
    // HandLandmarker resizes inputs internally to ~192x192 for palm detection.
    // Feeding it a downscaled frame avoids per-frame full-HD blits without
    // hurting accuracy in practice.
    const scale = Math.min(1, DETECT_MAX_WIDTH / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (detectCanvas.width !== w) detectCanvas.width = w;
    if (detectCanvas.height !== h) detectCanvas.height = h;

    detectCtx.save();
    detectCtx.scale(-1, 1);
    detectCtx.drawImage(videoEl, -w, 0, w, h);
    detectCtx.restore();

    if (tsMs <= lastTimestamp) {
      tsMs = lastTimestamp + 1;
    }
    lastTimestamp = tsMs;

    return landmarker.detectForVideo(detectCanvas, tsMs);
  }

  function drawPip(ctx, canvasW, canvasH) {
    if (!ready || videoEl.readyState < 2) return;
    const pipW = Math.round(canvasW * 0.15);
    const pipH = Math.round(pipW * (9 / 16));
    const margin = Math.round(canvasW * 0.02);
    const x = canvasW - pipW - margin;
    const y = margin;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 2, y - 2, pipW + 4, pipH + 4);

    ctx.translate(x + pipW, y);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, 0, 0, pipW, pipH);
    ctx.restore();

    ctx.strokeRect(x - 2, y - 2, pipW + 4, pipH + 4);
  }

  function stop() {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (landmarker) {
      landmarker.close();
      landmarker = null;
    }
    ready = false;
  }

  return {
    init,
    detectForVideo,
    drawPip,
    stop,
    get ready() {
      return ready;
    },
    get error() {
      return error;
    },
    setError(msg) {
      error = msg;
    },
  };
}
