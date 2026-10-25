const {chromium}=require('/usr/local/lib/python3.13/site-packages/playwright/driver/package');
const assert=require('assert'),fs=require('fs');
const dir='/data/threads-desk/editorial-batch-03';fs.mkdirSync(dir,{recursive:true});
const base='http://127.0.0.1:8765/';
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});const errors=[];
 const c=await b.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});
 const initial={kind:'threads-desk-backup',version:1,records:{A0:{done:true,published_at:'',url:'',history:[]},D13:{done:true,published_at:'',url:'',history:[]}},custom_people:{u123456789abc:{id:'u123456789abc',name:'Private custom character',zones:[{label:'Москва',zone:'Europe/Moscow'}],created_at:'2026-10-25T00:00:00Z'}},custom_posts:{u123456789abc_private001:{id:'u123456789abc_private001',source_id:'private001',person:'u123456789abc',text:'Private existing text',order:0}}};
 await c.addInitScript(initial=>{if(!sessionStorage.getItem('initialized-test')){localStorage.setItem('threads-desk-v1',JSON.stringify(initial));sessionStorage.setItem('initialized-test','1');}},initial);
 const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.waitForFunction(()=>appReady);
 assert.equal(await p.evaluate(()=>SEED.posts.length),52); // 51 public + 1 private fixture
 assert(await p.evaluate(()=>state.records.A0.done&&state.records.D13.done));assert.equal(await p.evaluate(()=>state.custom_posts.u123456789abc_private001.text),'Private existing text');
 for(const person of ['A','D','E']){
  await p.locator(`#tabs [data-person=${person}]`).click();await p.waitForFunction(person=>window.location.hash==='#'+person,person);
  for(const n of [15,16]){
   const id=person+n,card=p.locator(`#cards [data-id=${id}]`);await card.waitFor();
   const data=await p.evaluate(id=>SEED.posts.find(p=>p.id===id),id);assert(!/[\u2013\u2014]/.test(data.text+(data.continuation||'')));assert([...data.text].length<=500);assert.equal(await card.locator('.continuation').count(),n===15?1:0);
   await card.locator('[data-copy]').first().click();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),data.text);
   if(data.continuation){await card.locator('[data-copy-field=continuation]').click();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),data.continuation);}
  }
  assert.equal(await p.locator(`#cards [data-id=${person}1]`).count(),0,'historical hidden short drafts must stay hidden');
 }
 await p.locator('#tabs [data-person=A]').click();await p.locator('#cards [data-id=A16]').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-90));await p.screenshot({path:dir+'/qa-new-short-mobile.png'});
 await p.locator('#cards [data-done=A16]').click();assert(await p.evaluate(()=>state.records.A16.done));await p.reload();await p.waitForFunction(()=>appReady);assert(await p.evaluate(()=>state.records.A16.done&&state.records.A0.done));assert.equal(await p.locator('#cards [data-id=A16]').count(),0);
 assert.equal(await p.evaluate(()=>state.custom_posts.u123456789abc_private001.text),'Private existing text');
 await p.locator('#tabs [data-person=D]').click();await p.locator('#cards [data-id=D15]').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-90));await p.screenshot({path:dir+'/qa-new-thread-mobile.png'});
 await p.setViewportSize({width:1440,height:1000});await p.locator('#cards [data-id=D15]').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-90));await p.screenshot({path:dir+'/qa-new-thread-desktop.png'});
 // New queue flag is typed, and malformed flags cannot bypass content validation.
 assert(await p.evaluate(()=>{const d=JSON.parse(JSON.stringify({kind:'threads-content',version:1,people:originalLibrary.people,posts:originalLibrary.posts}));d.posts.find(p=>p.id==='A16').queue_visible='yes';try{validateContent(d);return false;}catch{return true;}}));
 assert.deepEqual(errors,[]);await b.close();console.log('PASS six new cards, three short/three threaded, exact clipboard, legacy queue unchanged, existing records/private library preserved, publish/reload and typed queue flag.');
})().catch(e=>{console.error(e);process.exit(1)});
