const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const pending = new Map();
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.kind !== 'tf-probe-response') return;
  const resolve = pending.get(data.messageId);
  if (!resolve) return;
  pending.delete(data.messageId);
  resolve(data);
});
async function clientsNow() {
  return self.clients.matchAll({includeUncontrolled:true, type:'window'});
}
async function offscreenClient() {
  const list = await clientsNow();
  return list.find(c => c.url === OFFSCREEN_URL);
}
async function ensureOffscreen() {
  if (await offscreenClient()) return;
  await chrome.offscreen.createDocument({
    url:'offscreen.html', reasons:['WORKERS'], justification:'Torsionfield lifecycle probe'
  });
  for (let i=0;i<40;i++) {
    const c=await offscreenClient(); if (c) return;
    await new Promise(r=>setTimeout(r,25));
  }
  throw new Error('offscreen creation not observable');
}
async function sendProbe() {
  await ensureOffscreen();
  // Repaired rule: always resolve the current offscreen Client.
  const target=await offscreenClient();
  if (!target) throw new Error('current offscreen client unavailable');
  const messageId=crypto.randomUUID();
  const response=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(messageId);reject(new Error('probe timeout'));},1500);
    pending.set(messageId,(data)=>{clearTimeout(timer);resolve(data);});
  });
  target.postMessage({kind:'tf-probe',messageId});
  const data=await response;
  return {targetId:target.id,targetUrl:target.url,...data};
}
async function recreateOffscreen() {
  const before=await offscreenClient();
  if (before) await chrome.offscreen.closeDocument();
  for (let i=0;i<40 && await offscreenClient();i++) await new Promise(r=>setTimeout(r,25));
  await ensureOffscreen();
  const after=await offscreenClient();
  return {beforeId:before?.id??null,afterId:after?.id??null,changed:Boolean(before&&after&&before.id!==after.id)};
}
globalThis.tfProbe={sendProbe,recreateOffscreen,clientsNow};
