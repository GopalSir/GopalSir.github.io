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

  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn({ label, connected, frameCount });
  }

  async function decodeFrame(b64) {
    const blob = await fetch(`data:image/jpeg;base64,${b64}`).then((r) =>
      r.blob()
    );
    if (latestBitmap) {
      try {
        latestBitmap.close();
      } catch (_) {
        /* ignore */
      }
    }
    latestBitmap = await createImageBitmap(blob);
    frameCount++;
    notify();
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

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'frame' && data.data) {
          await decodeFrame(data.data);
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
    stop() {
      running = false;
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
