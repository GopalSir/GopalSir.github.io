/**
 * Port of bimanual_pi_client2_camera.py math (lines 32-223, 367-411).
 */

export const EMA_ALPHA = 0.3;
export const EXT_ON_THRESH = 0.68;
export const EXT_OFF_THRESH = 0.55;

export const THUMB_UP_EMA_ALPHA = 0.2;
export const THUMB_UP_ON_THRESH = 0.75;
export const THUMB_UP_OFF_THRESH = 0.4;

export const MAX_LINEAR_SPEED_MM_S = 50.0;
export const MAX_ANGULAR_SPEED_RAD_S = 0.8;
export const DEADZONE_RADIUS_PX = 100.0;
export const SATURATION_RADIUS_PX = 360.0;
export const VELOCITY_EXP_ALPHA = 4.0;
export const VELOCITY_EMA_ALPHA = 0.3;

export const SWITCH_PROB_POWER = 1.0;
export const MODE_SWITCH_ALLOW_PROB = 0.55;
export const MODE_SWITCH_COOLDOWN_MS = 180;

export const ROBOT_SEND_PERIOD_S = 0.04;
export const ENABLE_GRIPPER_ACTIONS = true;
export const NEUTRAL_FOLLOW_ALPHA = 0.2;
export const DEFAULT_CALIBRATION = Object.freeze({
  roll: 0,
  pitch: 0,
  yaw: 90,
});

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function expGain(u, alpha = VELOCITY_EXP_ALPHA) {
  if (alpha <= 0) return clamp01(u);
  return (Math.exp(alpha * clamp01(u)) - 1) / (Math.exp(alpha) - 1);
}

export function normalizeOffsetFromNeutral(dx, dy) {
  const r = Math.sqrt(dx * dx + dy * dy);
  const u =
    (r - DEADZONE_RADIUS_PX) /
    Math.max(1, SATURATION_RADIUS_PX - DEADZONE_RADIUS_PX);
  return { r, u: clamp01(u) };
}

export function switchProbabilityFromGain(vGain) {
  return clamp01((1 - clamp01(vGain)) ** SWITCH_PROB_POWER);
}

export function velocityForModeMmS(mode, dx, dy) {
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let wx = 0;
  let wy = 0;
  let wz = 0;
  const { r, u } = normalizeOffsetFromNeutral(dx, dy);
  if (r <= DEADZONE_RADIUS_PX) {
    return { vx, vy, vz, wx, wy, wz, gain: 0, u };
  }
  const gain = expGain(u);
  const ux = dx / (r + 1e-6);
  const uy = dy / (r + 1e-6);
  if (mode === 'YZ Plane') {
    vy = -MAX_LINEAR_SPEED_MM_S * gain * ux;
    vz = -MAX_LINEAR_SPEED_MM_S * gain * uy;
  } else if (mode === 'X Axis') {
    vx = MAX_LINEAR_SPEED_MM_S * gain * -ux;
  } else if (mode === 'Yaw/Pitch') {
    wz = MAX_ANGULAR_SPEED_RAD_S * gain * ux;
    wy = -MAX_ANGULAR_SPEED_RAD_S * gain * uy;
  } else if (mode === 'Roll') {
    wx = MAX_ANGULAR_SPEED_RAD_S * gain * ux;
  }
  return { vx, vy, vz, wx, wy, wz, gain, u };
}

function rotX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}

function rotY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

function rotZ(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function matMul(A, B) {
  const R = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return R;
}

export function matVecMul(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

/** scipy Rotation.from_euler('xyz', ..., degrees=True) @ diag([-1,1,1]) */
export function computeTransform(rollDeg, pitchDeg, yawDeg) {
  const roll = (rollDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const R = matMul(matMul(rotZ(yaw), rotY(pitch)), rotX(roll));
  const flip = [
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  return matMul(R, flip);
}

export function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function lineAlignmentError(a1, a2, b1, b2) {
  const v1 = [a2.x - a1.x, a2.y - a1.y, a2.z - a1.z];
  const v2 = [b2.x - b1.x, b2.y - b1.y, b2.z - b1.z];
  const n1 = Math.hypot(v1[0], v1[1], v1[2]);
  const n2 = Math.hypot(v2[0], v2[1], v2[2]);
  const cosTheta = Math.abs(
    (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2 + 1e-6)
  );
  return 1 - clamp01(cosTheta);
}

export function isFingerExtended(tip, dip, pip, mcp, wrist, palmScale) {
  const dTip = dist3(tip, wrist);
  const dMcp = dist3(mcp, wrist);
  const ratio = dTip / (dMcp + 1e-6);
  const colErr = lineAlignmentError(mcp, tip, dip, tip);
  const pipErr = lineAlignmentError(mcp, pip, pip, tip);
  return (
    0.45 * clamp01((ratio - 1) / 0.8) +
    0.25 * clamp01(1 - colErr / 0.35) +
    0.2 * clamp01(1 - pipErr / 0.35) +
    0.1 * clamp01(dTip / palmScale / 1.5)
  );
}

/** Mutable gesture / velocity controller state. */
export function createRobotController() {
  return {
    extScoreEma: [0, 0, 0, 0],
    extState: [false, false, false, false],
    thumbUpScoreEma: 0,
    thumbUpState: false,
    activeMode: 'IDLE',
    lastModeSwitchMs: 0,
    velCmd: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
    neutralCenterPx: null,
    lastDebug: {
      handCount: 0,
      labels: [],
      leftExt: [false, false, false, false],
      leftScores: [0, 0, 0, 0],
      leftModeNumber: 0,
      candidateMode: 'IDLE',
      activeMode: 'IDLE',
      clutchActive: true,
      switchProb: 1,
      vGain: 0,
      uDist: 0,
    },
    prevClutchActive: true,
    gripperState: 'OPEN',
    lastGripperState: 'OPEN',
    gripperOpenStopDeadline: null,
    manualStopHold: false,
    calibration: { ...DEFAULT_CALIBRATION },
    R_cam_to_base: computeTransform(
      DEFAULT_CALIBRATION.roll,
      DEFAULT_CALIBRATION.pitch,
      DEFAULT_CALIBRATION.yaw
    ),
    recomputeTransform() {
      const { roll, pitch, yaw } = this.calibration;
      this.R_cam_to_base = computeTransform(roll, pitch, yaw);
    },
    clamp01,
    smoothVelocityCommand(vx, vy, vz, wx, wy, wz) {
      const keys = ['x', 'y', 'z', 'rx', 'ry', 'rz'];
      const vals = [vx, vy, vz, wx, wy, wz];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        this.velCmd[k] =
          VELOCITY_EMA_ALPHA * vals[i] +
          (1 - VELOCITY_EMA_ALPHA) * this.velCmd[k];
      }
      return [
        this.velCmd.x,
        this.velCmd.y,
        this.velCmd.z,
        this.velCmd.rx,
        this.velCmd.ry,
        this.velCmd.rz,
      ];
    },
    maybeUpdateActiveMode(candidateMode, switchProb, nowMs) {
      if (
        candidateMode === this.activeMode ||
        (candidateMode !== 'IDLE' &&
          nowMs - this.lastModeSwitchMs < MODE_SWITCH_COOLDOWN_MS)
      ) {
        return;
      }
      if (
        candidateMode === 'IDLE' ||
        switchProb >= MODE_SWITCH_ALLOW_PROB
      ) {
        this.activeMode = candidateMode;
        this.lastModeSwitchMs = nowMs;
      }
    },
    processHandResults(results, tsMs) {
      let clutchActive = true;
      let rightMode = 'IDLE';
      let leftWristPx = null;
      let vGain = 0;
      let uDist = 0;
      let switchProb = 1;

      const landmarks = results?.landmarks ?? results?.handLandmarks ?? [];
      const handednesses = results?.handednesses ?? results?.handedness ?? [];
      const debugLabels = [];
      let debugLeftScores = [...this.extScoreEma];
      let debugLeftExt = [...this.extState];
      let debugLeftModeNumber = 0;

      if (landmarks.length) {
        for (let idx = 0; idx < landmarks.length; idx++) {
          const lm = landmarks[idx];
          const label = handednesses[idx]?.[0]?.categoryName;
          debugLabels.push(label || 'unknown');

          if (label === 'Right') {
            clutchActive = false;
            const thumbTip = lm[4];
            const thumbMcp = lm[2];
            const wrist = lm[0];
            const handSize = dist3(lm[0], lm[9]) + 1e-6;

            const tipAboveMcp = clamp01(
              (thumbMcp.y - thumbTip.y) / (handSize * 0.5)
            );
            const thumbExtent = clamp01(
              (dist3(thumbTip, wrist) - dist3(thumbMcp, wrist)) /
                (handSize * 0.3)
            );
            const rawThumbUp = 0.8 * tipAboveMcp + 0.2 * thumbExtent;

            this.thumbUpScoreEma =
              THUMB_UP_EMA_ALPHA * rawThumbUp +
              (1 - THUMB_UP_EMA_ALPHA) * this.thumbUpScoreEma;
            this.thumbUpState =
              this.thumbUpScoreEma >
              (this.thumbUpState ? THUMB_UP_OFF_THRESH : THUMB_UP_ON_THRESH);
            this.gripperState = this.thumbUpState ? 'CLOSED' : 'OPEN';
          } else if (label === 'Left') {
            const wrist = lm[0];
            leftWristPx = {
              x: Math.round(wrist.x * 1920),
              y: Math.round(wrist.y * 1080),
            };
            const tips = [lm[8], lm[12], lm[16], lm[20]];
            const dips = [lm[7], lm[11], lm[15], lm[19]];
            const pips = [lm[6], lm[10], lm[14], lm[18]];
            const mcps = [lm[5], lm[9], lm[13], lm[17]];
            const palmScale = dist3(lm[5], lm[17]) + 1e-6;
            const rawScores = tips.map((t, i) =>
              isFingerExtended(t, dips[i], pips[i], mcps[i], wrist, palmScale)
            );
            const ext = [];
            for (let i = 0; i < rawScores.length; i++) {
              this.extScoreEma[i] =
                EMA_ALPHA * rawScores[i] +
                (1 - EMA_ALPHA) * this.extScoreEma[i];
              this.extState[i] =
                this.extScoreEma[i] >
                (this.extState[i] ? EXT_OFF_THRESH : EXT_ON_THRESH);
              ext.push(this.extState[i]);
            }
            debugLeftScores = [...this.extScoreEma];
            debugLeftExt = [...ext];

            if (
              ext[0] &&
              !ext[1] &&
              !ext[2] &&
              !ext[3]
            ) {
              debugLeftModeNumber = 1;
              rightMode = 'YZ Plane';
            } else if (ext[0] && ext[1] && !ext[2] && !ext[3]) {
              debugLeftModeNumber = 2;
              rightMode = 'X Axis';
            } else if (ext[0] && ext[1] && ext[2] && !ext[3]) {
              debugLeftModeNumber = 3;
              rightMode = 'Yaw/Pitch';
            } else if (ext[0] && ext[1] && ext[2] && ext[3]) {
              debugLeftModeNumber = 4;
              rightMode = 'Roll';
            }
          }
        }
      }

      if (
        this.prevClutchActive &&
        !clutchActive &&
        leftWristPx !== null
      ) {
        this.neutralCenterPx = { ...leftWristPx };
      }
      if (clutchActive && leftWristPx !== null) {
        if (this.neutralCenterPx === null) {
          this.neutralCenterPx = { ...leftWristPx };
        } else {
          this.neutralCenterPx = {
            x: Math.round(
              (1 - NEUTRAL_FOLLOW_ALPHA) * this.neutralCenterPx.x +
                NEUTRAL_FOLLOW_ALPHA * leftWristPx.x
            ),
            y: Math.round(
              (1 - NEUTRAL_FOLLOW_ALPHA) * this.neutralCenterPx.y +
                NEUTRAL_FOLLOW_ALPHA * leftWristPx.y
            ),
          };
        }
      }

      let vx = 0;
      let vy = 0;
      let vz = 0;
      let wx = 0;
      let wy = 0;
      let wz = 0;

      if (
        !clutchActive &&
        leftWristPx !== null &&
        this.neutralCenterPx !== null
      ) {
        const dx = leftWristPx.x - this.neutralCenterPx.x;
        const dy = leftWristPx.y - this.neutralCenterPx.y;
        const norm = normalizeOffsetFromNeutral(dx, dy);
        uDist = norm.u;
        vGain = expGain(uDist);
        switchProb = switchProbabilityFromGain(vGain);
        this.maybeUpdateActiveMode(rightMode, switchProb, tsMs);
        const vel = velocityForModeMmS(this.activeMode, dx, dy);
        [vx, vy, vz, wx, wy, wz] = this.smoothVelocityCommand(
          vel.vx,
          vel.vy,
          vel.vz,
          vel.wx,
          vel.wy,
          vel.wz
        );
      } else {
        [vx, vy, vz, wx, wy, wz] = this.smoothVelocityCommand(
          0,
          0,
          0,
          0,
          0,
          0
        );
        this.activeMode = 'IDLE';
        switchProb = 1;
        vGain = 0;
        uDist = 0;
      }

      if (this.manualStopHold) {
        [vx, vy, vz, wx, wy, wz] = this.smoothVelocityCommand(
          0,
          0,
          0,
          0,
          0,
          0
        );
        this.activeMode = 'IDLE';
      }

      this.prevClutchActive = clutchActive;
      this.lastDebug = {
        handCount: landmarks.length,
        labels: debugLabels,
        leftExt: debugLeftExt,
        leftScores: debugLeftScores,
        leftModeNumber: debugLeftModeNumber,
        candidateMode: rightMode,
        activeMode: this.activeMode,
        clutchActive,
        switchProb,
        vGain,
        uDist,
      };

      return {
        clutchActive,
        rightMode,
        leftWristPx,
        vGain,
        uDist,
        switchProb,
        vx,
        vy,
        vz,
        wx,
        wy,
        wz,
      };
    },
    getTransformedVelocity(vx, vy, vz, wx, wy, wz) {
      const lin = matVecMul(this.R_cam_to_base, [vx, vy, vz]);
      const ang = matVecMul(this.R_cam_to_base, [wx, wy, wz]);
      return { vx: lin[0], vy: lin[1], vz: lin[2], wx: ang[0], wy: ang[1], wz: ang[2] };
    },
  };
}
