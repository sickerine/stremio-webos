// Wait for a presented frame, not just a play promise or currentTime assignment.
// Some WebKit builds report expectedDisplayTime in a different clock domain;
// use callback arrival time for duration measurements instead.
export function presentedFrame(video, action, { signal, target = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let frameId, timer, candidate = null, done = false;
    const started = performance.now();
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (frameId != null) video.cancelVideoFrameCallback(frameId);
      signal?.removeEventListener('abort', abort);
      video.removeEventListener('seeked', complete);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(null);
    const complete = () => { if (candidate && !video.seeking) finish(candidate); };
    const frame = (now, metadata) => {
      if (done) return;
      const advance = video.paused ? 0 : (performance.now() - started) / 1000 * (video.playbackRate || 1);
      if (target != null && (metadata.mediaTime < target - 0.08 || metadata.mediaTime > target + advance + 0.08)) {
        frameId = video.requestVideoFrameCallback(frame); return;
      }
      candidate = { latencyMs: performance.now() - started, mediaTime: metadata.mediaTime };
      complete();
    };
    if (signal?.aborted) return finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    video.addEventListener('seeked', complete);
    timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(frame);
    try { Promise.resolve(action()).catch(error => finish(null, error)); } catch (error) { finish(null, error); }
  });
}

export function seekLead(samples) {
  const usable = samples.filter(ms => Number.isFinite(ms) && ms >= 0 && ms <= 1000).slice(-5).sort((a, b) => a - b);
  return usable.length ? usable[Math.floor(usable.length / 2)] : 0;
}
