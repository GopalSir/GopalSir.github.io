/**
 * Lite 6 bimanual tablet web cockpit — entry point.
 */

import {
  APP_DEBUG_VERSION,
  CAMERA_WS_URL,
  CAMERA2_WS_URL,
  HAND_MODEL_PATH,
  MEDIAPIPE_WASM_BASE,
  cameraIndexForMode,
} from './config.js';
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

const DEBUG = true;
const DEBUG_LOG_PREFIX = '[cockpit-debug]';
const debugPanel = document.createElement('pre');
debugPanel.id = 'debug-panel';
dom.root.appendChild(debugPanel);

let stopFlag = false;
let gesturesReady = false;
let lastRobotSendTs = 0;
let rafId = null;
let lastDebugPanelUpdate = 0;
let lastModeLogged = null;
let lastCameraLogged = null;
let lastCam1FrameLogged = 0;
let lastCam2FrameLogged = 0;
const fpsStats = {
  lastTsMs: 0,
  lastCam1Frames: 0,
  lastCam2Frames: 0,
  renderAvg: 0,
  cam1Avg: 0,
  cam2Avg: 0,
};

const controller = createRobotController();
const robot = createRobotConnection();
const cam1 = createCameraReceiver(CAMERA_WS_URL, 'cam1');
const cam2 = createCameraReceiver(CAMERA2_WS_URL, 'cam2');
const gestures = createGestureTracker();
const compositor = createCompositor(dom.canvas);
const recorder = createEpisodeRecorder(dom.canvas);

function debugLog(event, data = {}) {
  if (!DEBUG) return;
  console.info(DEBUG_LOG_PREFIX, event, data);
}

function formatPt(pt) {
  if (!pt) return 'null';
  return `${pt.x},${pt.y}`;
}

function updateFpsStats(nowMs) {
  if (!fpsStats.lastTsMs) {
    fpsStats.lastTsMs = nowMs;
    fpsStats.lastCam1Frames = cam1.frameCount;
    fpsStats.lastCam2Frames = cam2.frameCount;
    return;
  }

  const dtMs = nowMs - fpsStats.lastTsMs;
  if (dtMs <= 0) return;

  const cam1Delta = cam1.frameCount - fpsStats.lastCam1Frames;
  const cam2Delta = cam2.frameCount - fpsStats.lastCam2Frames;
  const renderInst = 1000 / dtMs;
  const cam1Inst = (cam1Delta * 1000) / dtMs;
  const cam2Inst = (cam2Delta * 1000) / dtMs;
  const alpha = 0.2;

  fpsStats.renderAvg =
    fpsStats.renderAvg === 0
      ? renderInst
      : fpsStats.renderAvg * (1 - alpha) + renderInst * alpha;
  fpsStats.cam1Avg =
    fpsStats.cam1Avg === 0
      ? cam1Inst
      : fpsStats.cam1Avg * (1 - alpha) + cam1Inst * alpha;
  fpsStats.cam2Avg =
    fpsStats.cam2Avg === 0
      ? cam2Inst
      : fpsStats.cam2Avg * (1 - alpha) + cam2Inst * alpha;

  fpsStats.lastTsMs = nowMs;
  fpsStats.lastCam1Frames = cam1.frameCount;
  fpsStats.lastCam2Frames = cam2.frameCount;
}

function bootDebugSnapshot() {
  return {
    version: APP_DEBUG_VERSION,
    href: window.location.href,
    secureContext: window.isSecureContext,
    mediaDevices: !!navigator.mediaDevices,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    userAgent: navigator.userAgent,
    camera1: CAMERA_WS_URL,
    camera2: CAMERA2_WS_URL,
    handModel: HAND_MODEL_PATH,
    wasmBase: MEDIAPIPE_WASM_BASE,
  };
}

function updateDebugPanel({ tsMs, motion, hudState, selectedCamera }) {
  if (!DEBUG || tsMs - lastDebugPanelUpdate < 250) return;
  lastDebugPanelUpdate = tsMs;

  const dbg = controller.lastDebug;
  const scores = dbg.leftScores.map((v) => v.toFixed(2)).join(', ');
  const ext = dbg.leftExt.map((v) => (v ? '1' : '0')).join('');

  debugPanel.textContent = [
    `version=${APP_DEBUG_VERSION}`,
    `hands=${dbg.handCount} labels=${dbg.labels.join(',') || '-'}`,
    `leftExt=${ext} modeNo=${dbg.leftModeNumber} scores=[${scores}]`,
    `candidate=${dbg.candidateMode} active=${hudState.activeMode}`,
    `camera=${selectedCamera} clutch=${hudState.clutchActive ? 'LOCKED' : 'ACTIVE'}`,
    `neutral=${formatPt(hudState.neutralCenterPx)} leftWrist=${formatPt(hudState.leftWristPx)}`,
    `switchProb=${motion.switchProb.toFixed(2)} vGain=${motion.vGain.toFixed(2)} uDist=${motion.uDist.toFixed(2)}`,
    `fps(render/c1/c2)=${fpsStats.renderAvg.toFixed(1)}/${fpsStats.cam1Avg.toFixed(1)}/${fpsStats.cam2Avg.toFixed(1)}`,
    `camFrames=${cam1.frameCount}/${cam2.frameCount} camConn=${cam1.connected}/${cam2.connected} camActive=${cam1.active}/${cam2.active}`,
  ].join('\n');
}

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
  if (!cam1.connected || cam1.frameCount <= 3 || cam1.frameCount - lastCam1FrameLogged >= 120) {
    lastCam1FrameLogged = cam1.frameCount;
    debugLog('camera-1-update', {
      connected: cam1.connected,
      frameCount: cam1.frameCount,
    });
  }
});
cam2.onUpdate(() => {
  setDot(dom.cam2Dot, cam2.connected ? 'green' : 'red');
  if (!cam2.connected || cam2.frameCount <= 3 || cam2.frameCount - lastCam2FrameLogged >= 120) {
    lastCam2FrameLogged = cam2.frameCount;
    debugLog('camera-2-update', {
      connected: cam2.connected,
      frameCount: cam2.frameCount,
    });
  }
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
  debugLog('start-gestures-clicked');
  try {
    await gestures.init((msg) => {
      dom.overlayMsg.textContent = msg;
      debugLog('gesture-init-progress', { msg });
    });
    gesturesReady = true;
    debugLog('gesture-init-ready');
    hideOverlay();
    if (!rafId) loop();
  } catch (e) {
    console.error(e);
    gesturesReady = false;
    dom.btnStart.disabled = false;
    debugLog('gesture-init-error', {
      message: e?.message,
      stack: e?.stack,
    });
    dom.overlayMsg.textContent =
      e?.message ||
      'Camera / MediaPipe failed. Use HTTPS and allow camera access.';
  }
}

function boot() {
  debugLog('boot', bootDebugSnapshot());
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
  updateFpsStats(performance.now());
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
  const selectedCamera = cameraIndexForMode(hudState.activeMode);
  cam1.setActive(selectedCamera === 1);
  cam2.setActive(selectedCamera === 2);

  if (hudState.activeMode !== lastModeLogged) {
    lastModeLogged = hudState.activeMode;
    debugLog('active-mode-change', {
      activeMode: hudState.activeMode,
      candidateMode: motion.rightMode,
      selectedCamera,
      handDebug: controller.lastDebug,
    });
  }
  if (selectedCamera !== lastCameraLogged) {
    lastCameraLogged = selectedCamera;
    debugLog('camera-selection-change', {
      selectedCamera,
      activeMode: hudState.activeMode,
      expected: 'mode 1/3 -> camera 1, mode 2/4 -> camera 2',
    });
  }

  compositor.render({
    cam1: cam1.bitmap,
    cam2: cam2.bitmap,
    hudState,
    gestureTracker: gesturesReady ? gestures : null,
  });
  updateDebugPanel({ tsMs, motion, hudState, selectedCamera });

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
  debugLog('window-error', {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
  });
  showOverlay(`Error: ${e.message || 'failed to load'}`);
  if (dom.btnStart) dom.btnStart.disabled = false;
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  debugLog('unhandled-rejection', {
    reason: e.reason?.message || e.reason,
    stack: e.reason?.stack,
  });
  showOverlay(`Error: ${e.reason?.message || e.reason || 'unknown'}`);
  if (dom.btnStart) dom.btnStart.disabled = false;
});

robot.onStatus(updateRobotStatus);
updateCalibLabel();
boot();
