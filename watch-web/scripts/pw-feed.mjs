import { chromium } from "playwright";
const b=await chromium.launch({headless:true});const p=await b.newPage({viewport:{width:1280,height:720}});
p.on("pageerror",e=>console.log("[err]",e.message.slice(0,150)));
await p.goto("http://127.0.0.1:3211/?room=home");
for(let i=0;i<7;i++){await p.waitForTimeout(4000);const w=await p.evaluate(()=>{try{const w=window.__watch();return{feed:w.feed,rs:w.video.rs,buffered:w.buffered.length,net:w.net.fetchedMB,retries:w.net.retries}}catch(e){return String(e)}});console.log(JSON.stringify(w));}
await b.close();
