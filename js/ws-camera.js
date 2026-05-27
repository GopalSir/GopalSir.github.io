/**
 * WebRTC camera receiver with WebSocket signaling.
 *
 * Signaling URL is still CAMERA_WS_URL / CAMERA2_WS_URL so existing tunnel
 * ingress can stay the same; payload is now SDP offer/answer JSON instead of
 * per-frame JPEG blobs.
 *
 * Both camera peers stay at full send rate; mode changes only switch which
 * video element the compositor draws (no server pause/resume).
 */

const DEFAULT_ICE_SERVERS = [
  {
    urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  },
];

function waitForIceGatheringComplete(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onState);
        finish();
      }
    };
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

export function createCameraReceiver(url, label = 'cam', iceServers = DEFAULT_ICE_SERVERS) {
  let ws = null;
  let pc = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let fallbackFrameTimer = null;
  let running = true;
  let connected = false;
  let frameCount = 0;
  let negotiating = false;
  let lastFallbackVideoTime = -1;
  let frameCallbackArmed = false;

  const listeners = new Set();
  const videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline', '');
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.preload = 'none';

  function notify() {
    for (const fn of listeners) fn({ label, connected, frameCount });
  }

  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    notify();
  }

  function startFrameCounter() {
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      if (frameCallbackArmed) return;
      frameCallbackArmed = true;
      const onFrame = () => {
        if (!running) {
          frameCallbackArmed = false;
          return;
        }
        frameCount++;
        notify();
        videoEl.requestVideoFrameCallback(onFrame);
      };
      videoEl.requestVideoFrameCallback(onFrame);
      return;
    }

    if (fallbackFrameTimer) return;
    fallbackFrameTimer = setInterval(() => {
      if (!running) return;
      if (videoEl.readyState >= 2 && videoEl.currentTime !== lastFallbackVideoTime) {
        lastFallbackVideoTime = videoEl.currentTime;
        frameCount++;
        notify();
      }
    }, 33);
  }

  function sendSignal(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  function closePeer() {
    if (pc) {
      try {
        pc.close();
      } catch (_) {
        /* ignore */
      }
      pc = null;
    }
    setConnected(false);
  }

  async function negotiate() {
    if (!running || negotiating) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    negotiating = true;
    try {
      closePeer();
      pc = new RTCPeerConnection({ iceServers });
      pc.addTransceiver('video', { direction: 'recvonly' });

      pc.ontrack = (event) => {
        const stream = event.streams?.[0];
        if (stream && videoEl.srcObject !== stream) {
          videoEl.srcObject = stream;
        }
        void videoEl.play().catch(() => {});
        startFrameCounter();
      };

      pc.onconnectionstatechange = () => {
        const state = pc ? pc.connectionState : 'closed';
        setConnected(state === 'connected');
        console.info(`[${label}] webrtc-state=${state}`);
        if (state === 'failed' && running && ws && ws.readyState === WebSocket.OPEN) {
          setTimeout(() => {
            void negotiate();
          }, 400);
        }
        if (state === 'disconnected' && running && ws && ws.readyState === WebSocket.OPEN) {
          setTimeout(() => {
            if (pc && pc.connectionState === 'disconnected') {
              void negotiate();
            }
          }, 1200);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      sendSignal({
        type: 'offer',
        sdp: pc.localDescription ? pc.localDescription.sdp : offer.sdp,
      });
    } catch (e) {
      console.error(`[${label}] negotiate:`, e);
    } finally {
      negotiating = false;
    }
  }

  function connect() {
    if (!running) return;
    closePeer();
    setConnected(false);

    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }

    ws = new WebSocket(url);

    ws.onopen = () => {
      sendSignal({ type: 'ping' });
      pingTimer = setInterval(() => {
        sendSignal({ type: 'ping' });
      }, 15000);
      void negotiate();
    };

    ws.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (payload.type === 'answer' && payload.sdp && pc) {
        try {
          await pc.setRemoteDescription({
            type: 'answer',
            sdp: payload.sdp,
          });
          void videoEl.play().catch(() => {});
        } catch (e) {
          console.error(`[${label}] setRemoteDescription:`, e);
        }
      } else if (payload.type === 'ready') {
        // Server announces signaling readiness. If peer dropped unexpectedly,
        // this lets us re-negotiate quickly without waiting for reconnect.
        if (!pc) {
          void negotiate();
        }
      } else if (payload.type === 'error') {
        console.error(`[${label}] server:`, payload.message || 'unknown error');
      }
    };

    ws.onerror = () => {
      setConnected(false);
    };

    ws.onclose = () => {
      setConnected(false);
      clearInterval(pingTimer);
      pingTimer = null;
      closePeer();
      if (running) {
        reconnectTimer = setTimeout(connect, 1500);
      }
    };
  }

  connect();

  return {
    get bitmap() {
      return videoEl.readyState >= 2 ? videoEl : null;
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
      clearInterval(pingTimer);
      clearInterval(fallbackFrameTimer);
      pingTimer = null;
      fallbackFrameTimer = null;
      frameCallbackArmed = false;

      closePeer();
      if (ws) {
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      if (videoEl.srcObject) {
        const stream = videoEl.srcObject;
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch (_) {
            /* ignore */
          }
        }
        videoEl.srcObject = null;
      }
    },
  };
}
