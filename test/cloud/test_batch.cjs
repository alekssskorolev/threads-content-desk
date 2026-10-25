const {chromium}=require('/usr/local/lib/python3.13/site-packages/playwright/driver/package');
const assert=require('assert'),fs=require('fs');
const EP='https://functions.yandexcloud.net/d4emlk00avk75e7ldlp7',KEY='c'.repeat(64),BASE='http://127.0.0.1:8765/';
fs.mkdirSync('/data/threads-desk/batch-update',{recursive:true});
let stored=null,revision=0;const clone=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});let errors=[];
 async function page(width=390){const c=await b.newContext({viewport:{width,height:844},permissions:['clipboard-read','clipboard-write']});
 await c.addInitScript(({EP,KEY})=>localStorage.setItem('threads-desk-cloud-v1',JSON.stringify({version:1,endpoint:EP,key:KEY})),{EP,KEY});
 await c.route(EP,async r=>{const d=r.request().postDataJSON();let status=200,result;if(d.op==='get')result={state:clone(stored),revision};else if(d.expectedRevision!==revision){status=409;result={conflict:true};}else{stored=clone(d.state);result={revision:++revision};}await r.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});});
 const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(BASE);await ready(p);return p;}
 async function ready(p){await p.waitForFunction(()=>appReady&&document.getElementById('cloudStatus').textContent==='Облако: синхронизировано');}
 const p=await page();const originals=await p.evaluate(()=>JSON.stringify(originalLibrary));
 await p.locator('#addPerson').click();await p.locator('#personName').fill('Московский автор');await p.locator('#personForm button[type=submit]').click();await ready(p);const id=await p.evaluate(()=>person);
 await p.locator('#settingsButton').click();await p.screenshot({path:'/data/threads-desk/batch-update/qa-settings-mobile.png'});
 const dl=p.waitForEvent('download');await p.locator('#exportAgentContext').click();const context=JSON.parse(fs.readFileSync(await (await dl).path(),'utf8'));
 assert.equal(context.characters.length,4);assert(context.characters.some(c=>c.character_id===id));assert(context.characters[0].posts.length>0);assert(context.characters[0].used_post_ids.includes('A0'));assert(!JSON.stringify(context).includes(KEY));assert(!JSON.stringify(context).includes(EP));
 console.log('PASS context exports real custom IDs and existing texts, without cloud credentials');
 await p.locator('#showBatchHelp').click();assert((await p.locator('#batchInstructions').innerText()).includes('U+2014'));await p.screenshot({path:'/data/threads-desk/batch-update/qa-help-mobile.png'});await p.locator('#closeBatchHelp').click();
 const data={kind:'threads-posts-batch',version:1,characters:[['A','Adam Bennett'],['D','Daniel Reed'],['E','Emma Hayes'],[id,'Московский автор']].map(([character_id,character_name])=>({character_id,character_name,posts:[{id:'batch-001-post-001',text:'A concrete new first block for '+character_name,continuation:'The complete continuation. '.repeat(30)}]}))};
 async function upload(data){await p.locator('#batchPostsFile').setInputFiles({name:'all-characters-posts.json',mimeType:'application/json',buffer:Buffer.from('\uFEFF'+JSON.stringify(data))});await p.waitForTimeout(100);}
 const before=await p.evaluate(()=>JSON.stringify(state));await upload(data);await p.locator('#importPreview[open]').waitFor();assert.equal(await p.locator('#importPreviewList li').count(),4);assert.equal(await p.evaluate(()=>JSON.stringify(state)),before);
 await p.screenshot({path:'/data/threads-desk/batch-update/qa-preview-mobile.png'});await p.locator('#confirmPostsImport').click();await ready(p);assert.equal(Object.keys(stored.custom_posts).length,4);assert.equal(await p.evaluate(()=>JSON.stringify(originalLibrary)),originals);assert.equal(await p.locator('#settingsDialog').evaluate(e=>e.open),false);
 await p.locator('#tabs [data-person=A]').click();const ids=await p.locator('#cards [data-done]').evaluateAll(es=>es.map(e=>e.dataset.done));assert.equal(ids.at(-1),'A_batch-001-post-001');assert.equal(ids[0],'A0');
 await p.locator('#cards [data-done="A_batch-001-post-001"]').click();await ready(p);assert(stored.records['A_batch-001-post-001'].done);
 const q=await page(1440);assert.equal(await q.evaluate(()=>Object.keys(state.custom_posts).length),4);assert(await q.evaluate(()=>state.records['A_batch-001-post-001'].done));await q.locator('#tabs [data-person=D]').click();assert(await q.locator('#cards [data-done="D_batch-001-post-001"]').isVisible());
 console.log('PASS atomic four-person import, existing queue preserved, appended built-in posts sync across browsers');
 await p.locator('#settingsButton').click();const stable=await p.evaluate(()=>JSON.stringify(state));await upload(data);assert.equal(await p.locator('#importPreview').evaluate(e=>e.open),false);assert.equal(await p.evaluate(()=>JSON.stringify(state)),stable);
 async function rejects(value){await upload(value);assert.equal(await p.locator('#importPreview').evaluate(e=>e.open),false);assert.equal(await p.evaluate(()=>JSON.stringify(state)),stable);assert((await p.locator('#toast').innerText()).includes('Файл не загружен'));}
 let bad=clone(data);bad.characters[0].posts[0].text='Changed existing text';bad.characters[1].posts=[{id:'another-new',text:'Must not partially import'}];await rejects(bad);
 bad=clone(data);bad.characters[0].character_id='u000000000000';await rejects(bad);
 bad=clone(data);bad.characters[0].character_name='Wrong name';await rejects(bad);
 bad=clone(data);bad.characters.push(clone(bad.characters[0]));await rejects(bad);
 bad=clone(data);bad.characters[0].posts.push(clone(bad.characters[0].posts[0]));await rejects(bad);
 bad=clone(data);bad.characters[0].posts=[];await rejects(bad);
 bad=clone(data);bad.characters[0].posts[0]={id:'long',text:'😀'.repeat(501)};await rejects(bad);
 bad=clone(data);bad.characters[0].posts[0]={id:'longrest',text:'First',continuation:'x'.repeat(12001)};await rejects(bad);
 bad=clone(data);bad.characters.forEach(g=>g.posts=Array.from({length:76},(_,i)=>({id:'many-'+i,text:'New'})));await rejects(bad);
 bad=clone(data);bad.characters[0].posts=Array.from({length:101},(_,i)=>({id:'many-'+i,text:'New'}));await rejects(bad);
 bad=clone(data);bad.characters.forEach(g=>g.posts=Array.from({length:10},(_,i)=>({id:'size-'+i,text:'New',continuation:'x'.repeat(12000)})));await rejects(bad);
 // A valid file that would exceed the overall state cap is refused at confirmation, not partially applied.
 bad=clone(data);bad.characters[0].posts=Array.from({length:38},(_,i)=>({id:'cap-'+i,text:'New',continuation:'x'.repeat(12000)}));bad.characters=bad.characters.slice(0,1);
 // Serialized file exceeds 450K; existing state stays intact via early validation.
 await rejects(bad);
 // Overall state limit also rejects an individually valid small file atomically.
 const fill={kind:'threads-posts-batch',version:1,characters:[{character_id:'A',character_name:'Adam Bennett',posts:Array.from({length:36},(_,i)=>({id:'fill-'+i,text:'New',continuation:'x'.repeat(12000)}))}]};
 await upload(fill);await p.locator('#importPreview[open]').waitFor();await p.locator('#confirmPostsImport').click();await ready(p);
 const filled=await p.evaluate(()=>JSON.stringify(state));await p.locator('#settingsButton').click();
 fill.characters[0].posts=Array.from({length:6},(_,i)=>({id:'over-'+i,text:'New',continuation:'x'.repeat(12000)}));
 await upload(fill);await p.locator('#confirmPostsImport').click();assert((await p.locator('#importError').innerText()).includes('лимит'));assert.equal(await p.evaluate(()=>JSON.stringify(state)),filled);await p.locator('#cancelPostsImport').click();
 console.log('PASS duplicate-safe repeat; changed ID, bad target/name, duplicate groups/IDs and all limits reject without partial changes');
 await p.locator('#closeSettings').click();await q.locator('#settingsButton').click();await q.screenshot({path:'/data/threads-desk/batch-update/qa-settings-desktop.png'});await q.locator('#showBatchHelp').click();await q.screenshot({path:'/data/threads-desk/batch-update/qa-help-desktop.png'});
 assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await b.close();console.log('All batch tests passed; only mocked cloud used.');
})().catch(e=>{console.error(e);process.exit(1)});
