/**
 * Episode recording via MediaRecorder on compositor canvas.
 */

export function createEpisodeRecorder(canvas) {
  let mediaRecorder = null;
  let chunks = [];
  let recordStartTime = null;
  let recording = false;

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function pickMimeType() {
    // Prefer hardware-friendly codecs first; vp9 is high quality but CPU-heavy
    // on Android tablets and competes with the live render loop.
    const candidates = [
      'video/webm;codecs=h264',
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    for (const c of candidates) {
      if (
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported(c)
      ) {
        return c;
      }
    }
    return '';
  }

  function start() {
    if (recording) return false;
    chunks = [];
    const stream = canvas.captureStream(30);
    const mimeType = pickMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recordStartTime = new Date().toISOString();
    mediaRecorder.start(200);
    recording = true;
    return true;
  }

  function stop(extraMeta = {}) {
    return new Promise((resolve) => {
      if (!recording || !mediaRecorder) {
        resolve(null);
        return;
      }
      recording = false;
      const startIso = recordStartTime;

      mediaRecorder.onstop = () => {
        const recordEndTime = new Date().toISOString();
        const totalTimeSec =
          (Date.parse(recordEndTime) - Date.parse(startIso)) / 1000;
        const blob = new Blob(chunks, { type: 'video/webm' });
        const stamp = startIso.replace(/[:.]/g, '-');
        const meta = {
          recordStartTime: startIso,
          recordEndTime,
          totalTimeSec,
          ...extraMeta,
        };
        downloadBlob(blob, `episode_${stamp}.webm`);
        const jsonBlob = new Blob([JSON.stringify(meta, null, 2)], {
          type: 'application/json',
        });
        downloadBlob(jsonBlob, `episode_${stamp}.json`);
        resolve(meta);
        chunks = [];
        mediaRecorder = null;
        recordStartTime = null;
      };

      mediaRecorder.stop();
    });
  }

  return {
    start,
    stop,
    get recording() {
      return recording;
    },
  };
}
