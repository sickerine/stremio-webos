// Plain-text subtitles (SRT / WebVTT in Matroska) rendered by the browser's own
// TextTrack, styled via ::cue. One track element per Matroska track, cues appended
// live as the demux emits them.
export class TextSubtitles {
  constructor(video) { this.video = video; this.tracks = new Map(); this.active = null; this.seen = new Map(); this.dupes = 0; }
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
    // The demux re-emits a block whenever the byte stream resyncs (playback start, a TV
    // seek, the TV's blip to 0 on load). Same start + text = same cue; adding it again
    // makes the browser stack two identical lines.
    const key = `${s.time}:${text}`;
    let seen = this.seen.get(trackNumber); if (!seen) this.seen.set(trackNumber, seen = new Set());
    if (seen.has(key)) { this.dupes++; return; } seen.add(key);
    try { tt.addCue(new VTTCue(start, end, text)); } catch {}
  }
  show(trackNumber) { this.hide(); const tt = this.tracks.get(trackNumber); if (tt) { tt.mode = "showing"; this.active = trackNumber; } }
  hide() { for (const tt of this.tracks.values()) tt.mode = "hidden"; this.active = null; }
}
