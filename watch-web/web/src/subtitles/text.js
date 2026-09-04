// Plain-text subtitles (SRT / WebVTT in Matroska) rendered by the browser's own
// TextTrack, styled via ::cue. One track element per Matroska track, cues appended
// live as the demux emits them.
export class TextSubtitles {
  constructor(video) { this.video = video; this.tracks = new Map(); this.active = null; }
  setTracks(tracks) {
    for (const t of tracks) {
      if (t.type !== "utf8" && t.type !== "webvtt" && t.type !== "srt") continue;
      const tt = this.video.addTextTrack("subtitles", t.name || t.language || `Track ${t.number}`, t.language || "");
      tt.mode = "hidden";
      this.tracks.set(t.number, tt);
    }
  }
  addCue(trackNumber, s) {
    const tt = this.tracks.get(trackNumber); if (!tt) return;
    const start = s.time / 1000, end = start + Math.max(0.2, (s.duration ?? 2000) / 1000);
    const text = String(s.text || "").replace(/<[^>]+>/g, m => (/^<\/?(i|b|u)>$/i.test(m) ? m : "")).replace(/\{\\[^}]*\}/g, "");
    try { tt.addCue(new VTTCue(start, end, text)); } catch {}
  }
  show(trackNumber) { this.hide(); const tt = this.tracks.get(trackNumber); if (tt) { tt.mode = "showing"; this.active = trackNumber; } }
  hide() { for (const tt of this.tracks.values()) tt.mode = "hidden"; this.active = null; }
}
