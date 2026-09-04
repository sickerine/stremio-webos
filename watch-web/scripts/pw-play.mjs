import { chromium, firefox } from "playwright";
const [bn="chromium", waitMax="40"]=process.argv.slice(2);
const b=await (bn==="firefox"?firefox:chromium).launch({headless:true});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on("pageerror",e=>console.log("[err]",e.message.slice(0,160)));
await p.goto("http://127.0.0.1:3211/?room=home");
const t0=Date.now();let last=null;
while((Date.now()-t0)/1000<Number(waitMax)){
  await p.waitForTimeout(3000);
  const w=await p.evaluate(()=>{try{const w=window.__watch();return{t:+w.video.t.toFixed(1),rs:w.video.rs,w:w.video.w,paused:w.video.paused,mime:window.__session()?.pipeline?.currentMime,sel:w.selectedAudio,buffered:w.buffered.map(r=>+((r[1]-r[0]).toFixed(0))),ov:document.querySelector("[data-overlay]").hidden,net:w.net.fetchedMB}}catch(e){return String(e)}});
  console.log(JSON.stringify(w));
  if(w&&w.rs===4&&w.t>0&&!w.paused){if(last!==null&&w.t>last){console.log("PLAYING, mime:",w.mime);break;}last=w.t;}
}
await p.screenshot({path:"/tmp/pw-play.png"});
await b.close();
