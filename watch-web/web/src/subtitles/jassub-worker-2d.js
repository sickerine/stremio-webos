// Diagnostic variant of the jassub worker that refuses WebGL so libass output goes
// through the Canvas2D renderer. Selected with ?ass2d=1.
const orig = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (type, ...rest) {
  if (type === "webgl2" || type === "webgl" || type === "webgpu") return null;
  return orig.call(this, type, ...rest);
};
import "jassub/dist/worker/worker.js";
