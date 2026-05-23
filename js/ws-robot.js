/**
 * Robot command WebSocket (wss://robot.anantlibrary.in).
 */

import { TUNNEL_URL } from './config.js';

export function createRobotConnection() {
  let ws = null;
  let reconnectTimer = null;
  let running = false;
  let queue = [];
  let armed = false;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      fn({ connected: !!ws && ws.readyState === WebSocket.OPEN, armed });
    }
  }

  function flushQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      const msg = queue.shift();
      ws.send(msg);
    }
  }

  function sendCommand(cmd) {
    const msg = JSON.stringify(cmd);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      queue.push(msg);
    }
  }

  function safeStopRobot() {
    sendCommand({ vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 });
  }

  function sendRobotVelocity(vx, vy, vz, wxRad, wyRad, wzRad) {
    sendCommand({
      vx,
      vy,
      vz,
      wx: (wxRad * 180) / Math.PI,
      wy: (wyRad * 180) / Math.PI,
      wz: (wzRad * 180) / Math.PI,
    });
  }

  function connectLoop() {
    if (!running) return;
    ws = new WebSocket(TUNNEL_URL);

    ws.onopen = () => {
      flushQueue();
      notify();
    };

    ws.onclose = () => {
      notify();
      if (running) {
        reconnectTimer = setTimeout(connectLoop, 2000);
      }
    };

    ws.onerror = () => {
      notify();
    };
  }

  function start() {
    if (running) return;
    running = true;
    connectLoop();
  }

  function connectRobot() {
    start();
    armed = true;
    notify();
    setTimeout(() => {
      sendCommand({ type: 'motion_enable', enable: true });
      sendCommand({ type: 'clean_error' });
      sendCommand({ type: 'set_mode', mode: 5 });
      sendCommand({ type: 'set_state', state: 0 });
    }, 1000);
  }

  function stop() {
    running = false;
    armed = false;
    clearTimeout(reconnectTimer);
    safeStopRobot();
    queue = [];
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
      ws = null;
    }
    notify();
  }

  function isReady() {
    return armed && ws && ws.readyState === WebSocket.OPEN;
  }

  return {
    sendCommand,
    safeStopRobot,
    sendRobotVelocity,
    connectRobot,
    stop,
    isReady,
    get armed() {
      return armed;
    },
    onStatus(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
