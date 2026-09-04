import { WebSocket } from "ws";
const URL = process.env.URL;
const ws = new WebSocket("ws://127.0.0.1:3310/ws?role=tv&room=home");
let pos = Number(process.env.POS||250), seq = 0, paused = false;
ws.on("open", () => {
  const send = () => ws.send(JSON.stringify({ type:"state", state:{
    sessionId:"live-1", sequence:++seq, positionSeconds:pos, paused, playbackRate:1,
    buffering:false, mediaUrl:URL, title:"Tsuihou S1E08", episodeId:"kitsu:49183:8" }}));
  send();
  setInterval(() => { if(!paused) pos += 1; send(); }, 1000);
  // expose pause/seek control via stdin
  process.stdin.on("data", d => {
    const c = d.toString().trim();
    if (c==="pause"){paused=true;} else if(c==="play"){paused=false;}
    else if(c.startsWith("seek ")){pos=Number(c.slice(5));}
    console.log("TV now pos="+pos.toFixed(0)+" paused="+paused);
  });
});
console.log("TV simulator connected");
