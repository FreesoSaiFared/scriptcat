import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const mode=process.argv[2];
if(!['stale','repaired'].includes(mode)) throw new Error('mode stale|repaired');
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),mode);
const port=mode==='stale'?9321:9322;
const profile=`/tmp/tf-offscreen-${mode}-${process.pid}`;
const chrome=spawn('/usr/bin/chromium',[
  '--headless=new','--no-sandbox','--disable-dev-shm-usage','--remote-allow-origins=*',
  `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,
  `--disable-extensions-except=${root}`,`--load-extension=${root}`,'about:blank'
],{stdio:['ignore','pipe','pipe']});
let stderr=''; chrome.stderr.on('data',d=>stderr+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function targets(){return fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());}
let sw;
for(let i=0;i<80;i++){
  try{sw=(await targets()).find(t=>t.type==='service_worker'&&t.url.includes('chrome-extension://'));}catch{}
  if(sw)break; await sleep(100);
}
if(!sw){chrome.kill('SIGTERM');throw new Error(`service worker target missing\n${stderr.slice(-2000)}`);}
let seq=0; const pending=new Map();
const ws=new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
async function cdp(method,params={}){const id=++seq;const p=new Promise(r=>pending.set(id,r));ws.send(JSON.stringify({id,method,params}));return p;}
await cdp('Runtime.enable');
async function evalExpr(expression,awaitPromise=true){
  const r=await cdp('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});
  if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const swId=sw.id;
let first, recreation, second, error=null;
try{
  first=await evalExpr('tfProbe.sendProbe()');
  recreation=await evalExpr('tfProbe.recreateOffscreen()');
  try{second=await evalExpr('tfProbe.sendProbe()');}catch(e){error=String(e.message||e);}
  const currentSw=(await targets()).find(t=>t.type==='service_worker'&&t.url===sw.url);
  const out={mode,serviceWorkerTargetBefore:swId,serviceWorkerTargetAfter:currentSw?.id??null,serviceWorkerSurvived:currentSw?.id===swId,first,recreation,second,error};
  console.log(JSON.stringify(out,null,2));
  await fs.writeFile(path.resolve(path.dirname(new URL(import.meta.url).pathname),`result-${mode}.json`),JSON.stringify(out,null,2)+'\n');
} finally {
  ws.close(); chrome.kill('SIGTERM'); await sleep(300);
}
