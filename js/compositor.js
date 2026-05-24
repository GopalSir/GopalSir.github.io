/**
 * Full-bleed robot stream + HUD + PIP compositor.
 */

import { cameraIndexForMode } from './config.js';
import { drawHud } from './hud.js';

export function createCompositor(canvas) {
  const ctx = canvas.getContext('2d');

  const MAX_DPR = 1.25;

  function resizeToContainer(container) {
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function sourceSize(source) {
    if (!source) return { iw: 0, ih: 0 };
    const iw = source.videoWidth || source.displayWidth || source.width || 0;
    const ih = source.videoHeight || source.displayHeight || source.height || 0;
    return { iw, ih };
  }

  function drawWaiting(w, h) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#444';
    ctx.font = `${Math.round(w * 0.02)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for camera…', w / 2, h / 2);
    ctx.textAlign = 'left';
  }

  function drawCover(source, w, h) {
    if (!source) {
      drawWaiting(w, h);
      return;
    }
    const { iw, ih } = sourceSize(source);
    if (!iw || !ih) {
      drawWaiting(w, h);
      return;
    }
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    try {
      ctx.drawImage(source, dx, dy, dw, dh);
    } catch (_) {
      // Source (VideoFrame/ImageBitmap/video) changed state between selection
      // and draw; skip this frame and wait for next render.
      drawWaiting(w, h);
    }
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
