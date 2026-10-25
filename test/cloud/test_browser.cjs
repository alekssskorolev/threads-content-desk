const {chromium}=require('/usr/local/lib/python3.13/site-packages/playwright/driver/package');
const fs=require('fs');
const assert=require('assert');
const ENDPOINT='https://functions.yandexcloud.net/d4emlk00avk75e7ldlp7';
const KEY='a'.repeat(64), URL='http://127.0.0.1:8765/';
const clone=v=>JSON.parse(JSON.stringify(v));
const empty=()=>({kind:'threads-desk-backup',version:1,records:{}});
let stored=null,revision=0,offline=false,puts=0,dropAck=false,holdPut=null;
let pageErrors=[];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 async function context(initial,configured=true){
  const c=await browser.newContext({timezoneId:'Europe/Moscow',viewport:{width:1280,height:1000},permissions:['clipboard-read','clipboard-write']});
  await c.addInitScript(({initial,configured,ENDPOINT,KEY})=>{
   if(!sessionStorage.getItem('fixture-loaded')){
    if(initial)localStorage.setItem('threads-desk-v1',JSON.stringify(initial));
    if(configured)localStorage.setItem('threads-desk-cloud-v1',JSON.stringify({version:1,endpoint:ENDPOINT,key:KEY}));
    sessionStorage.setItem('fixture-loaded','yes');
   }
  },{initial,configured,ENDPOINT,KEY});
  await c.route(ENDPOINT,async route=>{
   if(offline){await route.abort('failed');return;}
   const req=route.request(),headers=req.headers();
   if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}});return;}
   if(headers['x-desk-key']!==KEY){await route.fulfill({status:401,body:'{}'});return;}
   const data=req.postDataJSON();let status=200,result;
   if(data.op==='get')result={revision,state:clone(stored)};
   else if(data.op==='put'){
    if(holdPut){const wait=holdPut;holdPut=null;await wait;}
    if(data.expectedRevision!==revision){status=409;result={conflict:true};}
    else{stored=clone(data.state);revision++;puts++;result={revision};if(dropAck){dropAck=false;await route.abort('failed');return;}}
   }else throw Error('Unknown op');
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  });
  return c;
 }
 async function open(c,path=''){
  const p=await c.newPage();p.on('pageerror',e=>pageErrors.push(e.message));
  p.on('dialog',d=>d.accept());
  await p.clock.install({time:new Date('2026-10-25T12:50:00Z')});
  await p.goto(URL+path);await p.waitForFunction(()=>typeof state!=='undefined'&&document.getElementById('tabs').children.length>0).catch(()=>{});
  return p;
 }
 async function ready(p){await p.waitForFunction(()=>document.getElementById('cloudStatus').textContent==='Облако: синхронизировано',{},{timeout:15000});}
 async function wait(fn,p){await p.waitForFunction(fn,{},{timeout:15000});}
 async function tick(p){await p.evaluate(()=>window.dispatchEvent(new Event('online')));}
 async function setDone(p,id,value){
  await p.evaluate(({id,value})=>{const r=record(id);r.done=value;if(value&&!r.published_at)r.published_at=new Date().toISOString();save();render();},{id,value});
 }
 // Unconfigured version remains local and existing publishing UI is unchanged.
 const c0=await context(null,false),p0=await open(c0);
 assert(await p0.locator('#cloudBar').isHidden());
 const ids=await p0.locator('#cards input[data-done]').evaluateAll(es=>es.map(e=>e.dataset.done));
 assert(ids.length>=2,'current queue available');
 await p0.locator(`#cards input[data-done="${ids[0]}"]`).click();
 assert(await p0.evaluate(id=>JSON.parse(localStorage.getItem('threads-desk-v1')).records[id].done,ids[0]));
 assert.equal(puts,0);await c0.close();
 console.log('PASS local-only publishing unchanged');
 const initial=empty();initial.records.A0={done:true,published_at:'2026-10-24T12:00:00Z',url:'',history:[]};
 const cA=await context(initial),a=await open(cA);
 await a.getByText('Перенос отметок в облако',{exact:true}).waitFor();
 assert.equal(puts,0,'no implicit startup upload');
 assert(await a.evaluate(()=>!!localStorage.getItem('threads-desk-before-cloud-v1')));
 await a.getByRole('button',{name:'Перенести отметки этого браузера',exact:true}).click();await ready(a);
 assert(stored.records.A0.done);console.log('PASS explicit migration with backup');
 const before=puts,cB=await context(null),b=await open(cB);await ready(b);
 assert(await b.evaluate(()=>state.records.A0.done));assert.equal(puts,before,'new browser must not upload empty state');
 const id1=ids[0],id2=ids[1];
 await setDone(b,id1,true);await ready(b);await tick(a);await ready(a);
 assert(await a.evaluate(id=>state.records[id].done,id1));console.log('PASS cross-browser cloud load and publication');
 // Simultaneous offline edits to different records merge safely.
 offline=true;
 await setDone(a,id1,false);await setDone(b,id2,true);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),a);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),b);
 offline=false;await tick(a);await tick(b);await ready(a);await ready(b);
 assert.equal(stored.records[id1].done,false);assert.equal(stored.records[id2].done,true);
 await tick(a);await ready(a);assert(await a.evaluate(id=>state.records[id].done,id2));
 console.log('PASS concurrent different-post edits merged');
 // Same-record conflicts are not overwritten until the owner makes a choice.
 await tick(b);await ready(b);offline=true;
 await a.evaluate(id=>{record(id).url='https://www.threads.com/@byadambennett/post/TEST123';save();render();},id2);
 await setDone(b,id2,false);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),a);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),b);
 offline=false;await tick(a);await ready(a);await tick(b);
 await b.getByText('Один и тот же пост изменён в двух браузерах',{exact:true}).waitFor();
 assert.equal(stored.records[id2].done,true);
 assert(await b.evaluate(id=>state.records[id].done===false,id2));
 await b.getByRole('button',{name:'Сохранить мои изменения',exact:true}).click();await ready(b);
 assert.equal(stored.records[id2].done,false);console.log('PASS conflict pauses writes and honors explicit resolution');
 // Offline state survives a reload and resumes against its original baseline.
 offline=true;await setDone(b,id1,true);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),b);
 await b.reload();await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),b);
 assert(await b.evaluate(id=>state.records[id].done,id1));
 offline=false;await tick(b);await ready(b);assert.equal(stored.records[id1].done,true);
 console.log('PASS offline queue survives reload');
 // A committed request with a lost response must not lose the user's changes.
 dropAck=true;await setDone(b,id1,false);
 await wait(()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'),b);
 assert.equal(stored.records[id1].done,false);await tick(b);await ready(b);
 assert.equal(stored.records[id1].done,false);console.log('PASS lost acknowledgement is safely retried');
 // Changes made while a PUT is in flight are rebased, not overwritten by its reply.
 let release;holdPut=new Promise(resolve=>release=resolve);
 await setDone(b,id1,true);await b.waitForTimeout(750);
 await setDone(b,id2,true);release();await ready(b);
 await b.waitForTimeout(800);await ready(b);
 assert.equal(stored.records[id1].done,true);assert.equal(stored.records[id2].done,true);
 console.log('PASS rapid edits during an in-flight write preserved');
 // Metadata and state backups never carry the API credential.
 const data=await b.evaluate(()=>({state:localStorage.getItem('threads-desk-v1'),meta:localStorage.getItem('threads-desk-cloud-meta-v1'),backup:localStorage.getItem('threads-desk-before-cloud-v1')}));
 assert(!JSON.stringify(data).includes(KEY));
 // First connection to nonempty cloud does not overwrite local or cloud data.
 const local=empty();local.records.E0={done:true,published_at:'',url:'',history:[]};
 const cC=await context(local),c=await open(cC);await c.getByText('Перенос отметок в облако',{exact:true}).waitFor();
 const cloudBefore=clone(stored);await c.getByRole('button',{name:'Объединить с облаком',exact:true}).click();await ready(c);
 assert(stored.records.E0.done);for(const id of Object.keys(cloudBefore.records))assert.deepEqual(stored.records[id],cloudBefore.records[id]);
 console.log('PASS first-time merge preserves existing cloud records');
 // Setup fragment disappears before any cloud request; setup page never uploads state.
 const cD=await context(null,false),d=await cD.newPage();d.on('dialog',x=>x.accept());
 d.on('pageerror',e=>pageErrors.push(e.message));
 await d.goto(URL+'cloud-connect.html#'+new URLSearchParams({endpoint:ENDPOINT,key:KEY}));
 assert(!d.url().includes('#'));assert(!d.url().includes(KEY));
 await d.locator('#consent').check();const putsBeforeSetup=puts;
 await d.getByRole('button',{name:'Проверить и подключить',exact:true}).click();await d.waitForURL(URL);await ready(d);
 assert.equal(puts,putsBeforeSetup);assert(await d.evaluate(()=>!!localStorage.getItem('threads-desk-cloud-v1')));
 console.log('PASS private setup link sanitized; key tested without uploading state');
 // Invalid key/config does not silently degrade to writable stale local data.
 const cE=await context(initial);await cE.addInitScript(()=>localStorage.setItem('threads-desk-cloud-v1',JSON.stringify({version:1,endpoint:'https://evil.example',key:'a'.repeat(64)})));
 const e=await open(cE);await e.getByText('Неверная настройка облака. Подключите заново или отключите.',{exact:true}).waitFor();
 assert.equal(await e.evaluate(()=>cloudSync.canEdit()),false);
 console.log('PASS invalid endpoint rejected and edits gated');
 assert.deepEqual(pageErrors,[], 'No unhandled browser exceptions');
 await a.screenshot({path:'/data/threads-desk/cloud/preview-synced-desktop.png',fullPage:false});
 await c.screenshot({path:'/data/threads-desk/cloud/preview-synced-mobile.png',fullPage:false});
 await browser.close();console.log('All cloud browser tests passed. Mock API only; no real secret used.');
})().catch(e=>{console.error(e);process.exit(1)});
