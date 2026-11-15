import "./comparison.css";

const FRAME_TIME = 32.089;
const stage = document.querySelector(".comparison-stage");
const status = document.querySelector("#comparison-status");
let split = 50, activePointer = null;

function setSplit(value) {
  split = Math.max(0, Math.min(100, value));
  stage.style.setProperty("--split", `${split}%`);
  stage.setAttribute("aria-valuenow", String(Math.round(split)));
  stage.setAttribute("aria-valuetext", `${Math.round(split)}% Dolby Vision, ${Math.round(100 - split)}% HDR10`);
}

function move(event) {
  const rect = stage.getBoundingClientRect();
  setSplit((event.clientX - rect.left) / rect.width * 100);
}

stage.addEventListener("pointerdown", event => {
  if (event.button !== 0 || activePointer !== null) return;
  event.preventDefault();
  stage.focus({ preventScroll: true });
  activePointer = event.pointerId;
  stage.setPointerCapture(event.pointerId);
  move(event);
});
stage.addEventListener("pointermove", event => { if (activePointer === event.pointerId) move(event); });
function finishDrag(event) {
  if (activePointer !== event.pointerId) return;
  activePointer = null;
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
}
stage.addEventListener("pointerup", finishDrag);
stage.addEventListener("pointercancel", finishDrag);
stage.addEventListener("lostpointercapture", () => { activePointer = null; });
stage.addEventListener("keydown", event => {
  const step = event.shiftKey ? 10 : 1;
  let next = split;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= step;
  else if (event.key === "ArrowRight" || event.key === "ArrowUp") next += step;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 100;
  else return;
  event.preventDefault();
  setSplit(next);
});

function openPaused(video, file, name) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", fail);
    };
    const finish = () => { video.pause(); cleanup(); resolve(); };
    const fail = () => {
      cleanup();
      reject(new Error(`${name} could not load. This browser may not support HEVC video.`));
    };
    const metadata = () => { video.pause(); video.currentTime = FRAME_TIME; };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${name} did not finish loading. Refresh to try again.`));
    }, 45000);
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("seeked", finish);
    video.addEventListener("error", fail);
    video.pause();
    video.src = `/comparison/media/${file}`;
    video.load();
  });
}

Promise.all([
  openPaused(document.querySelector(".left-video"), "dolby-vision.mp4", "The Dolby Vision file"),
  openPaused(document.querySelector(".right-video"), "hdr10.mp4", "The HDR10 file"),
]).then(() => {
  status.textContent = `Both paused at ${FRAME_TIME.toFixed(3)} s`;
}).catch(error => { status.textContent = error.message; });
