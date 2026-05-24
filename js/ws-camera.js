/**
 * Dual WebSocket camera receivers.
 *
 * Wire protocol (server -> client):
 *   - Binary ArrayBuffer message  : raw JPEG bytes (preferred, default).
 *   - Text JSON message           : '{"type":"frame","data":"<base64>"}' (legacy).
 *
 * Wire protocol (client -> server):
 *   - '{"type":"pause"}'  -> ask server to stop sending until we resume.
 *   - '{"type":"resume"}' -> ask server to resume sending.
 *
 * Receiver only decodes the latest pending frame; older frames are dropped to
 * avoid building up end-to-end latency on tablets.
 *
 * Decode path (fastest first):
 *   1. ImageDecoder  — hardware-accelerated JPEG decode (Chrome/Edge 94+, Android).
 *      Returns a VideoFrame; compatible with ctx.drawImage() and .close().
 *   2. createImageBitmap — software fallback for older browsers.
 */

// Probe once at module load whether ImageDecoder + JPEG are available.
// isTypeSupported is sync in the spec but some environments make it async;
// we resolve it before the first frame arrives.
let _imageDecoderSupported = false;
if (typeof ImageDecoder !== 'undefined' && typeof ImageDecoder.isTypeSupported === 'function') {
  Promise.resolve(ImageDecoder.isTypeSupported('image/jpeg'))
    .then((ok) => { _imageDecoderSupported = !!ok; })
    .catch(() => { _imageDecoderSupported = false; });
}

export function createCameraReceiver(url, label = 'cam') {
  let ws = null;
  let reconnectTimer = null;
  let running = true;
  let latestBitmap = null;
  let connected = false;
  let frameCount = 0;
  let active = true;
  let lastSentActive = null; // last pause/resume value the server was told
  let decoding = false;
  // pendingFrame is an ArrayBuffer (binary) or string (legacy base64). null = none.
  let pendingFrame = null;

  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn({ label, connected, frameCount });
  }

  function base64ToUint8Array(b64) {
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  async function decodeFrameImageDecoder(bytes) {
    const decoder = new ImageDecoder({ data: bytes, type: 'image/jpeg' });
    try {
      const { image: frame } = await decoder.decode();
      // Convert VideoFrame → ImageBitmap so compositor can use .width/.height normally.
      // createImageBitmap(VideoFrame) is a GPU texture copy (~1ms) since the JPEG is
      // already decoded; the hardware speedup from ImageDecoder is still realised.
      try {
        return await createImageBitmap(frame);
      } finally {
        frame.close();
      }
    } finally {
      decoder.close();
    }
  }

  async function decodeFrame(input) {
    let bytes;
    if (input instanceof ArrayBuffer) {
      bytes = input;
    } else if (typeof input === 'string') {
      bytes = base64ToUint8Array(input).buffer;
    } else {
      return;
    }

    let newBitmap;
    if (_imageDecoderSupported) {
      try {
        newBitmap = await decodeFrameImageDecoder(bytes);
      } catch (e) {
        // ImageDecoder failed (corrupted frame, etc.) — fall through to createImageBitmap.
        newBitmap = null;
      }
    }
    if (!newBitmap) {
      newBitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    }

    const oldBitmap = latestBitmap;
    latestBitmap = newBitmap;
    if (oldBitmap) {
      try {
        oldBitmap.close();
      } catch (_) {
        /* ignore */
      }
    }
    frameCount++;
    notify();
  }

  async function drainLatestFrame() {
    if (decoding || !running || !active) return;
    decoding = true;
    try {
      while (running && active && pendingFrame !== null) {
        const input = pendingFrame;
        pendingFrame = null;
        await decodeFrame(input);
      }
    } finally {
      decoding = false;
      if (running && active && pendingFrame !== null) {
        void drainLatestFrame();
      }
    }
  }

  function syncActiveStateToServer() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (lastSentActive === active) return;
    try {
      ws.send(JSON.stringify({ type: active ? 'resume' : 'pause' }));
      lastSentActive = active;
    } catch (_) {
      /* ignore: will retry on next transition */
    }
  }

  function connect() {
    if (!running) return;
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    connected = false;
    lastSentActive = null;
    notify();

    ws = new WebSocket(url);
    // Critical: opt into binary frames as ArrayBuffer.
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      connected = true;
      notify();
      // Tell the server our current pause/resume state so it doesn't waste
      // CPU encoding for a camera we aren't viewing.
      syncActiveStateToServer();
    };

    ws.onmessage = (event) => {
      // When inactive, drop messages without parsing. The server will also
      // stop sending once it processes our 'pause', but messages can still
      // arrive in flight.
      if (!active) return;
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        // Newest frame wins; older pending frames are intentionally dropped.
        pendingFrame = data;
        void drainLatestFrame();
      } else if (typeof data === 'string') {
        // Legacy base64+JSON path (--legacy-text on the server).
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'frame' && parsed.data) {
            pendingFrame = parsed.data;
            void drainLatestFrame();
          }
        } catch (e) {
          console.error(`[${label}] frame decode:`, e);
        }
      }
    };

    ws.onerror = () => {
      connected = false;
      notify();
    };

    ws.onclose = () => {
      connected = false;
      lastSentActive = null;
      notify();
      if (running) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };
  }

  connect();

  return {
    get bitmap() {
      return latestBitmap;
    },
    get connected() {
      return connected;
    },
    get frameCount() {
      return frameCount;
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setActive(nextActive) {
      const newActive = !!nextActive;
      if (newActive === active) return;
      active = newActive;
      // Tell the server immediately so it can stop encoding for us.
      syncActiveStateToServer();
      if (active && pendingFrame !== null) {
        void drainLatestFrame();
      }
    },
    get active() {
      return active;
    },
    stop() {
      running = false;
      pendingFrame = null;
      clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      if (latestBitmap) {
        try {
          latestBitmap.close();
        } catch (_) {
          /* ignore */
        }
        latestBitmap = null;
      }
    },
  };
}
