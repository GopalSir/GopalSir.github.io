/**
 * Lite 6 bimanual tablet web cockpit — entry point.
 */

import { CAMERA_WS_URL, CAMERA2_WS_URL } from './config.js';
import {
  createRobotController,
  ROBOT_SEND_PERIOD_S,
  ENABLE_GRIPPER_ACTIONS,
} from './robot-math.js';
import { createCameraReceiver } from './ws-camera.js';
import { createRobotConnection } from './ws-robot.js';
import { createGestureTracker } from './gestures.js';
import { createCompositor } from './compositor.js';
import { createEpisodeRecorder } from './recorder.js';

const dom = {
  root: document.getElementById('cockpit-root'),
  canvas: document.getElementById('main-canvas'),
  overlay: document.getElementById('boot-overlay'),
  overlayMsg: document.getElementById('boot-msg'),
  robotDot: document.getElementById('robot-dot'),
  robotLabel: document.getElementById('robot-label'),
  cam1Dot: document.getElementById('cam1-dot'),
  cam2Dot: document.getElementById('cam2-dot'),
  btnConnect: document.getElementById('btn-connect'),
  btnEstop: document.getElementById('btn-estop'),
  btnRecord: document.getElementById('btn-record'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  btnExit: document.getElementById('btn-exit'),
  btnRollPlus: document.getElementById('btn-roll-plus'),
  btnRollMinus: document.getElementById('btn-roll-minus'),
  btnPitchPlus: document.getElementById('btn-pitch-plus'),
  btnPitchMinus: document.getElementById('btn-pitch-minus'),
  btnYawPlus: document.getElementById('btn-yaw-plus'),
  btnYawMinus: document.getElementById('btn-yaw-minus'),
  calibLabel: document.getElementById('calib-label'),
  advancedToggle: document.getElementById('advanced-toggle'),
  advancedPanel: document.getElementById('advanced-panel'),
  btnStart: document.getElementById('btn-start'),
};

let stopFlag = false;
let gesturesReady = false;
let lastRobotSendTs = 0;
let rafId = null;

const controller = createRobotController();
const robot = createRobotConnection();
const cam1 = createCameraReceiver(CAMERA_WS_URL, 'cam1');
const cam2 = createCameraReceiver(CAMERA2_WS_URL, 'cam2');
const gestures = createGestureTracker();
const compositor = createCompositor(dom.canvas);
const recorder = createEpisodeRecorder(dom.canvas);

function setDot(el, state) {
  el.className = 'dot ' + state;
}

function updateRobotStatus({ connected, armed }) {
  if (armed && connected) {
    setDot(dom.robotDot, 'green');
    dom.robotLabel.textContent = 'Robot: armed';
  } else if (armed) {
    setDot(dom.robotDot, 'yellow');
    dom.robotLabel.textContent = 'Robot: connecting…';
  } else {
    setDot(dom.robotDot, 'red');
    dom.robotLabel.textContent = 'Robot: offline';
  }
}

cam1.onUpdate(() => {
  setDot(dom.cam1Dot, cam1.connected ? 'green' : 'red');
});
cam2.onUpdate(() => {
  setDot(dom.cam2Dot, cam2.connected ? 'green' : 'red');
});

function updateCalibLabel() {
  const { roll, pitch, yaw } = controller.calibration;
  dom.calibLabel.textContent = `roll ${roll.toFixed(0)}°  pitch ${pitch.toFixed(0)}°  yaw ${yaw.toFixed(0)}°`;
}

function nudgeCalibration(key, delta) {
  controller.calibration[key] += delta;
  controller.recomputeTransform();
  updateCalibLabel();
}

function hideOverlay() {
  dom.overlay.classList.add('hidden');
}

function showOverlay(msg) {
  dom.overlayMsg.textContent = msg;
  dom.overlay.classList.remove('hidden');
}

async function startGestures() {
  dom.btnStart.disabled = true;
  showOverlay('Loading hand tracking…');
  try {
    await gestures.init((msg) => {
      dom.overlayMsg.textContent = msg;
    });
    gesturesReady = true;
    hideOverlay();
    if (!rafId) loop();
  } catch (e) {
    console.error(e);
    gesturesReady = false;
    dom.btnStart.disabled = false;
    dom.overlayMsg.textContent =
      e?.message ||
      'Camera / MediaPipe failed. Use HTTPS and allow camera access.';
  }
}

function boot() {
  dom.overlayMsg.textContent =
    'Robot cameras loading. Tap Start to enable hand tracking.';
  dom.overlay.classList.remove('hidden');
  dom.btnStart.disabled = false;
  loop();
}

function processGripper(nowS) {
  const c = controller;
  if (
    !ENABLE_GRIPPER_ACTIONS ||
    !robot.isReady() ||
    c.gripperState === c.lastGripperState
  ) {
    return;
  }
  if (c.gripperState === 'CLOSED') {
    robot.sendCommand({ type: 'gripper', action: 'close' });
    c.gripperOpenStopDeadline = null;
  } else {
    robot.sendCommand({ type: 'gripper', action: 'open' });
    c.gripperOpenStopDeadline = nowS + 1.2;
  }
  c.lastGripperState = c.gripperState;
}

function gripperStopIfDue(nowS) {
  const c = controller;
  if (
    ENABLE_GRIPPER_ACTIONS &&
    c.gripperOpenStopDeadline &&
    nowS >= c.gripperOpenStopDeadline
  ) {
    robot.sendCommand({ type: 'gripper', action: 'stop' });
    c.gripperOpenStopDeadline = null;
  }
}

function loop() {
  if (stopFlag) return;

  compositor.resizeToContainer(dom.root);
  const tsMs = Date.now();
  const results = gesturesReady ? gestures.detectForVideo(tsMs) : null;
  const motion = controller.processHandResults(results, tsMs);

  const nowS = performance.now() / 1000;
  if (robot.isReady() && nowS - lastRobotSendTs >= ROBOT_SEND_PERIOD_S) {
    const t = controller.getTransformedVelocity(
      motion.vx,
      motion.vy,
      motion.vz,
      motion.wx,
      motion.wy,
      motion.wz
    );
    robot.sendRobotVelocity(t.vx, t.vy, t.vz, t.wx, t.wy, t.wz);
    lastRobotSendTs = nowS;
  }

  processGripper(nowS);
  gripperStopIfDue(nowS);

  const hudState = {
    clutchActive: motion.clutchActive,
    gripperState: controller.gripperState,
    activeMode: controller.activeMode,
    vx: motion.vx,
    vy: motion.vy,
    vz: motion.vz,
    neutralCenterPx: controller.neutralCenterPx,
    leftWristPx: motion.leftWristPx,
    manualStopHold: controller.manualStopHold,
  };

  compositor.render({
    cam1: cam1.bitmap,
    cam2: cam2.bitmap,
    hudState,
    gestureTracker: gesturesReady ? gestures : null,
  });

  rafId = requestAnimationFrame(loop);
}

dom.btnStart.addEventListener('click', () => {
  startGestures();
});

dom.btnConnect.addEventListener('click', () => {
  if (!robot.armed) {
    robot.connectRobot();
    dom.btnConnect.textContent = 'Connected';
    dom.btnConnect.disabled = true;
  }
});

dom.btnEstop.addEventListener('click', () => {
  controller.manualStopHold = !controller.manualStopHold;
  dom.btnEstop.classList.toggle('active', controller.manualStopHold);
  if (controller.manualStopHold) {
    robot.safeStopRobot();
  }
});

dom.btnRecord.addEventListener('click', async () => {
  if (!recorder.recording) {
    recorder.start();
    dom.btnRecord.textContent = 'Stop';
    dom.btnRecord.classList.add('recording');
  } else {
    dom.btnRecord.textContent = 'Record';
    dom.btnRecord.classList.remove('recording');
    await recorder.stop({
      finalMode: controller.activeMode,
      calibration: { ...controller.calibration },
    });
  }
});

dom.btnFullscreen.addEventListener('click', async () => {
  if (!document.fullscreenElement) {
    await dom.root.requestFullscreen();
    dom.btnFullscreen.textContent = 'Exit FS';
  } else {
    await document.exitFullscreen();
    dom.btnFullscreen.textContent = 'Fullscreen';
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    dom.btnFullscreen.textContent = 'Fullscreen';
  }
});

dom.btnExit.addEventListener('click', () => {
  teardown();
  showOverlay('Session ended. Reload page to reconnect.');
});

dom.advancedToggle.addEventListener('click', () => {
  dom.advancedPanel.classList.toggle('open');
});

dom.btnRollPlus.addEventListener('click', () => nudgeCalibration('roll', 5));
dom.btnRollMinus.addEventListener('click', () => nudgeCalibration('roll', -5));
dom.btnPitchPlus.addEventListener('click', () => nudgeCalibration('pitch', 5));
dom.btnPitchMinus.addEventListener('click', () => nudgeCalibration('pitch', -5));
dom.btnYawPlus.addEventListener('click', () => nudgeCalibration('yaw', 5));
dom.btnYawMinus.addEventListener('click', () => nudgeCalibration('yaw', -5));

function teardown() {
  stopFlag = true;
  if (rafId) cancelAnimationFrame(rafId);
  robot.stop();
  cam1.stop();
  cam2.stop();
  gestures.stop();
  if (recorder.recording) {
    recorder.stop().catch(() => {});
  }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

window.addEventListener('beforeunload', () => {
  robot.safeStopRobot();
});

window.addEventListener('resize', () => {
  compositor.resizeToContainer(dom.root);
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    compositor.resizeToContainer(dom.root);
  }).observe(dom.root);
}

window.addEventListener('error', (e) => {
  console.error(e);
  showOverlay(`Error: ${e.message || 'failed to load'}`);
  if (dom.btnStart) dom.btnStart.disabled = false;
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  showOverlay(`Error: ${e.reason?.message || e.reason || 'unknown'}`);
  if (dom.btnStart) dom.btnStart.disabled = false;
});

robot.onStatus(updateRobotStatus);
updateCalibLabel();
boot();
