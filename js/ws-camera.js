/**
 * Dual WebSocket camera receivers (base64 JPEG frames).
 */

export function createCameraReceiver(url, label = 'cam') {
  let ws = null;
  let reconnectTimer = null;
  let running = true;
  let latestBitmap = null;
  let connected = false;
  let frameCount = 0;
  let active = true;
  let decoding = false;
  let pendingFrameB64 = null;

  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn({ label, connected, frameCount });
  }

  async function decodeFrame(b64) {
    const blob = await fetch(`data:image/jpeg;base64,${b64}`).then((r) =>
      r.blob()
    );
    const newBitmap = await createImageBitmap(blob);
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
      while (running && active && pendingFrameB64) {
        const b64 = pendingFrameB64;
        pendingFrameB64 = null;
        await decodeFrame(b64);
      }
    } finally {
      decoding = false;
      if (running && active && pendingFrameB64) {
        void drainLatestFrame();
      }
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
    notify();

    ws = new WebSocket(url);

    ws.onopen = () => {
      connected = true;
      notify();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'frame' && data.data) {
          // Keep only newest frame; older ones are dropped intentionally.
          pendingFrameB64 = data.data;
          if (active) {
            void drainLatestFrame();
          }
        }
      } catch (e) {
        console.error(`[${label}] frame decode:`, e);
      }
    };

    ws.onerror = () => {
      connected = false;
      notify();
    };

    ws.onclose = () => {
      connected = false;
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
      active = !!nextActive;
      if (active && pendingFrameB64) {
        void drainLatestFrame();
      }
    },
    get active() {
      return active;
    },
    stop() {
      running = false;
      pendingFrameB64 = null;
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
