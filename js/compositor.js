/**
 * Full-bleed robot stream + HUD + PIP compositor.
 */

import { cameraIndexForMode } from './config.js';
import { drawHud } from './hud.js';

export function createCompositor(canvas) {
  const ctx = canvas.getContext('2d');

  function resizeToContainer(container) {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function drawCover(bitmap, w, h) {
    if (!bitmap) {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#444';
      ctx.font = `${Math.round(w * 0.02)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for camera…', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const iw = bitmap.width;
    const ih = bitmap.height;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.drawImage(bitmap, dx, dy, dw, dh);
  }

  function render({ cam1, cam2, hudState, gestureTracker }) {
    const w = canvas.width;
    const h = canvas.height;
    const camIdx = cameraIndexForMode(hudState.activeMode);
    const bitmap = camIdx === 2 ? cam2 : cam1;

    drawCover(bitmap, w, h);
    drawHud(ctx, w, h, hudState);
    if (gestureTracker) {
      gestureTracker.drawPip(ctx, w, h);
    }
  }

  return { resizeToContainer, render, canvas, ctx };
}
