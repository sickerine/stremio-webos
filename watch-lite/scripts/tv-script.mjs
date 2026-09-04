import { WebSocket } from "ws";
const URL = process.env.URL;
const ws = new WebSocket("ws://127.0.0.1:3310/ws?role=tv&room=home");
let seq = 0;
const send = s => ws.send(JSON.stringify({ type:"state", state:{ sessionId:"scr-1", sequence:++seq, playbackRate:1, buffering:false, mediaUrl:URL, title:"scripted", episodeId:"kitsu:49183:8", ...s }}));
ws.on("open", async () => {
  const wait = ms => new Promise(r=>setTimeout(r,ms));
  let pos = 300, paused = false;
  const beat = setInterval(()=>{ if(!paused) pos+=1; send({positionSeconds:pos, paused}); }, 1000);
  console.log("PHASE playing @300"); await wait(14000);
  paused = true; send({positionSeconds:pos, paused}); console.log("PHASE paused @"+pos); await wait(8000);
  paused = false; pos = 500; send({positionSeconds:pos, paused}); console.log("PHASE seek->500 + play"); await wait(12000);
  clearInterval(beat); console.log("DONE"); process.exit(0);
});
