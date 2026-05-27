/**
 * HUD overlay — port of draw_hud() in bimanual_pi_client2_camera.py.
 */

import { DEADZONE_RADIUS_NORM, isInsideDeadzone } from './robot-math.js';
import { REF_WIDTH, REF_HEIGHT } from './config.js';
import { drawModeGizmo } from './gizmo.js';

function scalePt(pt, w, h) {
  if (!pt) return null;
  return {
    x: Math.round((pt.x * w) / REF_WIDTH),
    y: Math.round((pt.y * h) / REF_HEIGHT),
  };
}

function bgrFill(ctx, b, g, r, alpha = 1) {
  ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
}

function bgrStroke(ctx, b, g, r, alpha = 1) {
  ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
}

export function drawHud(ctx, w, h, state) {
  const nc = scalePt(state.neutralCenterPx, w, h);
  const lw = scalePt(state.leftWristPx, w, h);
  const dzRx = DEADZONE_RADIUS_NORM * w;
  const dzRy = DEADZONE_RADIUS_NORM * h;
  const dzR = Math.round((dzRx + dzRy) / 2);

  if (nc) {
    const circleActive = !state.clutchActive;
    bgrFill(ctx, 0, 255, 0, circleActive ? 0.25 : 0);
    if (!circleActive) bgrFill(ctx, 0, 0, 255, 0.25);
    ctx.beginPath();
    ctx.ellipse(nc.x, nc.y, dzRx, dzRy, 0, 0, Math.PI * 2);
    ctx.fill();

    if (circleActive) bgrStroke(ctx, 0, 255, 0, 1);
    else bgrStroke(ctx, 0, 0, 255, 1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(nc.x, nc.y, dzRx, dzRy, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (
      !state.clutchActive &&
      lw &&
      state.neutralCenterPx &&
      state.leftWristPx
    ) {
      const dx = state.leftWristPx.x - state.neutralCenterPx.x;
      const dy = state.leftWristPx.y - state.neutralCenterPx.y;
      if (!isInsideDeadzone(dx, dy)) {
        bgrStroke(ctx, 255, 255, 0, 1);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(nc.x, nc.y);
        ctx.lineTo(lw.x, lw.y);
        ctx.stroke();
      }
    }
  }

  let y = 30;
  const step = 25;
  const fontSize = Math.max(12, Math.round(w * 0.012));

  function drawText(text, b, g, r) {
    ctx.font = `${fontSize}px "Courier New", monospace`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(text, 15, y);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillText(text, 15, y);
    y += step;
  }

  if (state.clutchActive) {
    drawText('CLUTCH: LOCKED', 0, 0, 255);
  } else {
    drawText('CLUTCH: ACTIVE', 0, 255, 0);
  }
  drawText(`GRIPPER: ${state.gripperState}`, 0, 255, 255);
  drawText(`MODE: ${state.activeMode}`, 255, 200, 0);
  drawText(
    `Vlin: (${state.vx.toFixed(1)}, ${state.vy.toFixed(1)}, ${state.vz.toFixed(1)}) mm/s`,
    255,
    255,
    255
  );
  if (state.manualStopHold) {
    drawText('!! E-STOP HOLD !!', 0, 0, 255);
  }

  const camLabel =
    state.activeMode === 'X Axis' || state.activeMode === 'Roll'
      ? 'Camera 2'
      : 'Camera 1';
  drawText(`VIEW: ${camLabel}`, 180, 180, 180);

  if (nc) {
    drawModeGizmo(ctx, state.activeMode, nc, dzR);
  }
}
