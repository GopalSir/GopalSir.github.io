/**
 * Canvas port of gizmo.py (BGR colors converted to CSS rgb).
 */

const COL_X = 'rgb(220, 50, 0)';
const COL_Y = 'rgb(0, 210, 0)';
const COL_Z = 'rgb(0, 80, 220)';
const COL_DIM = 'rgb(55, 55, 55)';

const Y_DIR = [1, 0];
const Z_DIR = [0, -1];
const X_DIR = [0.18, 0.18];

function pt(cx, cy, direction, length) {
  return [
    Math.round(cx + direction[0] * length),
    Math.round(cy + direction[1] * length),
  ];
}

function scales(radius) {
  const r = Math.max(radius, 20);
  return {
    linLen: r * 0.78,
    xStub: r * 0.28,
    xDot: Math.max(3, Math.floor(r / 10)),
    lw: Math.max(1, Math.floor(r / 16)),
    ringR: r * 0.68,
    ringLw: Math.max(1, Math.floor(r / 12)),
  };
}

function drawArrow(ctx, x1, y1, x2, y2, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(6, lineWidth * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 7),
    y2 - headLen * Math.sin(angle - Math.PI / 7)
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 7),
    y2 - headLen * Math.sin(angle + Math.PI / 7)
  );
  ctx.closePath();
  ctx.fill();
}

function drawRotationRing(ctx, cx, cy, rx, ry, angleDeg, color, lineWidth, clockwise) {
  const startAngle = ((30 + angleDeg) * Math.PI) / 180;
  const sweep = (300 * Math.PI) / 180;
  const endAngle = clockwise ? startAngle + sweep : startAngle - sweep;

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, (angleDeg * Math.PI) / 180, startAngle, endAngle, !clockwise);
  ctx.stroke();

  const eaRad = (endAngle * 180) / Math.PI + angleDeg;
  const ea = (eaRad * Math.PI) / 180;
  const tipX = cx + rx * Math.cos(ea);
  const tipY = cy + ry * Math.sin(ea);
  const tangRad = ea + (clockwise ? Math.PI / 2 : -Math.PI / 2);
  const tangLen = Math.max(4, lineWidth * 3);
  const baseX = tipX - tangLen * Math.cos(tangRad);
  const baseY = tipY - tangLen * Math.sin(tangRad);
  drawArrow(ctx, baseX, baseY, tipX, tipY, color, lineWidth);
}

function dotIntoScreen(ctx, cx, cy, radius, color, lineWidth) {
  const r = Math.max(3, radius);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, Math.floor(r / 3)), 0, Math.PI * 2);
  ctx.fill();
}

export function drawModeGizmo(ctx, activeMode, centerPx, radius) {
  if (!centerPx) return;
  const cx = Math.round(centerPx.x);
  const cy = Math.round(centerPx.y);
  const sc = scales(radius);
  const lw = sc.lw;
  const ringLw = sc.ringLw;
  const lin = sc.linLen;
  const stub = sc.xStub;
  const xdot = sc.xDot;

  for (const [dir, len] of [
    [Y_DIR, lin],
    [Z_DIR, lin],
    [X_DIR, stub],
  ]) {
    const tip = pt(cx, cy, dir, len);
    ctx.strokeStyle = COL_DIM;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip[0], tip[1]);
    ctx.stroke();
  }

  const xt = pt(cx, cy, X_DIR, stub);
  ctx.strokeStyle = COL_DIM;
  ctx.beginPath();
  ctx.arc(xt[0], xt[1], Math.max(2, xdot - 1), 0, Math.PI * 2);
  ctx.stroke();

  if (activeMode === 'YZ Plane') {
    const yTip = pt(cx, cy, Y_DIR, lin);
    drawArrow(ctx, cx, cy, yTip[0], yTip[1], COL_Y, lw + 1);
    const zTip = pt(cx, cy, Z_DIR, lin);
    drawArrow(ctx, cx, cy, zTip[0], zTip[1], COL_Z, lw + 1);
  } else if (activeMode === 'X Axis') {
    const xTip = pt(cx, cy, X_DIR, stub * 1.15);
    ctx.strokeStyle = COL_X;
    ctx.lineWidth = lw + 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(xTip[0], xTip[1]);
    ctx.stroke();
    dotIntoScreen(ctx, xTip[0], xTip[1], xdot, COL_X, lw);

    const dashR = Math.round(sc.ringR * 0.55);
    for (let startA = 0; startA < 360; startA += 30) {
      const sRad = (startA * Math.PI) / 180;
      const eRad = ((startA + 15) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx + dashR * Math.cos(sRad), cy + dashR * Math.sin(sRad));
      ctx.lineTo(cx + dashR * Math.cos(eRad), cy + dashR * Math.sin(eRad));
      ctx.stroke();
    }
  } else if (activeMode === 'Yaw/Pitch') {
    const ringR = Math.round(sc.ringR);
    const ringRy = Math.max(4, Math.round(ringR * 0.18));
    drawRotationRing(ctx, cx, cy, ringR, ringRy, 0, COL_Z, ringLw, true);
    const ringRx = Math.max(4, Math.round(ringR * 0.18));
    drawRotationRing(ctx, cx, cy, ringRx, ringR, 0, COL_Y, ringLw, false);
  } else if (activeMode === 'Roll') {
    const ringR = Math.round(sc.ringR);
    drawRotationRing(ctx, cx, cy, ringR, ringR, 0, COL_X, ringLw, true);
    const xTip = pt(cx, cy, X_DIR, stub);
    ctx.strokeStyle = COL_X;
    ctx.lineWidth = lw + 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(xTip[0], xTip[1]);
    ctx.stroke();
    dotIntoScreen(ctx, xTip[0], xTip[1], xdot, COL_X, lw);
  } else {
    ctx.fillStyle = 'rgb(160, 160, 160)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, lw + 1), 0, Math.PI * 2);
    ctx.fill();
  }
}
