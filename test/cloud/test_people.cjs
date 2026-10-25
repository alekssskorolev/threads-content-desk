const {chromium}=require('/usr/local/lib/python3.13/site-packages/playwright/driver/package');
const assert=require('assert');
const EP='https://functions.yandexcloud.net/d4emlk00avk75e7ldlp7',KEY='b'.repeat(64),BASE='http://127.0.0.1:8765/';
const clone=x=>JSON.parse(JSON.stringify(x));
let stored=null,revision=0,puts=0,offline=false,errors=[];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 async function open(mobile=false){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile,timezoneId:'Asia/Tokyo',permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(({EP,KEY})=>{localStorage.setItem('threads-desk-cloud-v1',JSON.stringify({version:1,endpoint:EP,key:KEY}));},{EP,KEY});
  await context.route(EP,async route=>{
   if(offline)return route.abort('failed');
   const req=route.request();if(req.headers()['x-desk-key']!==KEY)return route.fulfill({status:401,body:'{}'});
   const d=req.postDataJSON();let status=200,result;
   if(d.op==='get')result={revision,state:clone(stored)};
   else if(d.op==='put'){
    if(d.expectedRevision!==revision){status=409;result={conflict:true};}
    else{stored=clone(d.state);revision++;puts++;result={revision};}
   }else throw Error('Unexpected op');
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
  await p.clock.install({time:new Date('2026-10-25T12:50:00Z')});await p.goto(BASE);await ready(p);return p;
 }
 async function ready(p){await p.waitForFunction(()=>document.getElementById('cloudStatus').textContent==='Облако: синхронизировано',{}, {timeout:15000});}
 async function wait(p,fn){await p.waitForFunction(fn,{}, {timeout:15000});}
 async function tick(p){await p.evaluate(()=>window.dispatchEvent(new Event('online')));}
 async function person(p,name,city='Москва'){
  await p.locator('#addPerson').click();await p.locator('#personName').fill(name);await p.locator('#personCity').fill(city);
  await p.locator('#personForm button[type=submit]').click();
  await p.waitForFunction(()=>!document.getElementById('personDialog').open);
  return p.evaluate(()=>person);
 }
 async function upload(p,data,name='posts.json'){
  const chooser=p.waitForEvent('filechooser');await p.locator('#uploadPosts').click();
  await (await chooser).setFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 }
 // No mutation before the async source fetch and local/cloud state initialization.
 const slow=await browser.newContext({viewport:{width:390,height:844}});
 await slow.addInitScript(()=>localStorage.setItem('threads-desk-v1',JSON.stringify({kind:'threads-desk-backup',version:1,records:{A0:{done:true,published_at:'',url:'',history:[]}}})));
 let releaseSource;const sourceGate=new Promise(resolve=>releaseSource=resolve);
 await slow.route('**/posts.json*',async route=>{await sourceGate;await route.continue();});
 const slowPage=await slow.newPage();await slowPage.goto(BASE);await slowPage.locator('#addPerson').click();
 assert.equal(await slowPage.locator('#personDialog').evaluate(e=>e.open),false);
 assert(await slowPage.evaluate(()=>JSON.parse(localStorage.getItem('threads-desk-v1')).records.A0.done));
 releaseSource();await slowPage.waitForFunction(()=>appReady);assert(await slowPage.evaluate(()=>state.records.A0.done));await slow.close();
 console.log('PASS initialization gate prevents early profile creation from overwriting existing local records');
 const p=await open();
 const clock=await p.locator('#accountClock').innerText();assert(clock.includes('Нью-Йорк 08:50')&&clock.includes('Лос-Анджелес 05:50')&&!clock.includes('Москва'));
 assert.equal(await p.locator('#utilities,#futurePosts,.publish-time,#globalStats,#shortDrafts').count(),0);
 assert((await p.locator('#cards .card').count())>3,'all pending queue visible without scheduling');
 assert.equal(await p.evaluate(()=>typeof buildLivePlan),'undefined');
 const originalRecords=await p.evaluate(()=>JSON.stringify(state.records));
 const originalContent=await p.evaluate(()=>JSON.stringify(originalLibrary));
 console.log('PASS original accounts: only regional clocks, full unscheduled queue, no extra functions or time headers');
 const id=await person(p,'Московский автор');await ready(p);
 assert(/u[a-f0-9]{12}/.test(id));assert(await p.locator('#personPanel').isVisible());
 assert.equal(await p.locator('#accountClock').innerText(),'25 октября · Москва 15:50');
 assert.equal(stored.custom_people[id].zones[0].zone,'Europe/Moscow');
 assert.equal(await p.locator('#cards .card').count(),0);
 assert.equal(await p.evaluate(()=>JSON.stringify(state.records)),originalRecords);
 console.log('PASS plus creates named city-specific mini-page and syncs profile without altering records');
 await p.setViewportSize({width:390,height:844});await p.waitForTimeout(100);assert(await p.evaluate(()=>{const a=document.querySelector('#tabs .active').getBoundingClientRect(),b=document.getElementById('tabs').getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;}));await p.screenshot({path:'/data/threads-desk/person-update/qa-empty-mobile.png'});await p.setViewportSize({width:1440,height:1000});
 const pack={kind:'threads-posts',version:1,posts:[{id:'post-001',text:'Русский первый блок\nВторая строка',continuation:'Продолжение. '.repeat(250)},{id:'post-002',text:'Одиночный пост <b>это текст</b>'}]};
 await upload(p,pack);await p.locator('#importPreview[open]').waitFor();
 assert.equal(await p.locator('#cards .card').count(),0,'preview must not import');await p.screenshot({path:'/data/threads-desk/person-update/qa-import-preview.png'});
 await p.locator('#cancelPostsImport').click();assert.equal(Object.keys(stored.custom_posts||{}).length,0);
 await upload(p,pack);await p.locator('#confirmPostsImport').click();await ready(p);
 assert.equal(await p.locator('#cards .card').count(),2);
 assert.equal(await p.locator(`#cards [data-id="${id}_post-001"] .opener .post`).textContent(),pack.posts[0].text);
 assert.equal(await p.locator(`#cards [data-id="${id}_post-001"] .continuation .post`).textContent(),pack.posts[0].continuation);
 assert.equal(await p.locator(`#cards [data-id="${id}_post-002"] b`).count(),0,'text must be escaped');
 assert.equal(Object.keys(stored.custom_posts).length,2);assert.equal(await p.evaluate(()=>JSON.stringify(originalLibrary)),originalContent);
 console.log('PASS JSON preview, cancel, atomic import, plain text and long continuation; original library unchanged');
 const before=puts;await upload(p,pack);await wait(p,()=>document.getElementById('toast').textContent.includes('уже загружены'));
 assert.equal(puts,before);assert.equal(Object.keys(stored.custom_posts).length,2);
 await upload(p,{...pack,posts:[{id:'post-003',text:'Не должен добавиться'},{id:'post-001',text:'Перезапись запрещена'}]});
 await wait(p,()=>document.getElementById('toast').textContent.includes('другим текстом'));
 assert(!stored.custom_posts[id+'_post-003']);assert.equal(stored.custom_posts[id+'_post-001'].text,pack.posts[0].text);
 for(const bad of [{...pack,posts:[{id:'bad',text:'😀'.repeat(501)}]},{...pack,posts:[{id:'__proto__',text:'test'}]},{...pack,posts:[{id:'same',text:'one'},{id:'same',text:'two'}]},{kind:'wrong',posts:[]}]){
  await upload(p,bad);await wait(p,()=>document.getElementById('toast').textContent.startsWith('Файл не загружен:'));
  assert.equal(Object.keys(stored.custom_posts).length,2);
 }
 console.log('PASS repeated imports skip duplicates; changed IDs, unsafe IDs and invalid files do not partially import');
 // Copy and publication still work; no fake scheduled time is written.
 await p.locator(`#cards [data-copy="${id}_post-001"][data-copy-field="continuation"]`).click();
 assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),pack.posts[0].continuation);
 await p.locator(`#cards [data-done="${id}_post-002"]`).click();await ready(p);
 assert(stored.records[id+'_post-002'].done);assert(!stored.records[id+'_post-002'].scheduled_slot);
 assert.equal(await p.locator('#cards .card').count(),1);
 const q=await open(true);const countBefore=puts;
 await q.locator(`#tabs [data-person="${id}"]`).click();await wait(q,()=>document.getElementById('accountClock').textContent.includes('Москва'));assert.equal(await q.locator('#accountClock').innerText(),'25 октября · Москва 15:50');
 assert.equal(await q.locator('#cards .card').count(),1);assert.equal(puts,countBefore,'second browser must not upload an empty library');
 assert.equal(await q.locator('#archiveLabel').innerText(),'Опубликованные · 1');
 console.log('PASS copied text and publication; phone loads new profile, texts, city and published status from cloud');
 // Mobile no nested scroll: both the blank divider and continuation pan the entire page.
 const divider=q.locator('#cards .thread-divider');await divider.scrollIntoViewIfNeeded();
 const box=await divider.boundingBox();assert(box.height>=44&&box.width>=320);
 const inner=q.locator('#cards .continuation .post');
 const dimensions=await inner.evaluate(e=>({h:e.clientHeight,s:e.scrollHeight,overflow:getComputedStyle(e).overflowY,max:getComputedStyle(e).maxHeight}));
 assert(dimensions.s<=dimensions.h+1&&dimensions.overflow==='visible'&&dimensions.max==='none');
 await q.evaluate(()=>{window.copiedDuringScroll=0;document.addEventListener('click',e=>{if(e.target.closest('[data-copy]'))window.copiedDuringScroll++;},true);});
 const cdp=await q.context().newCDPSession(q);const x=box.x+box.width/2,y=Math.min(box.y+box.height/2,700),startY=await q.evaluate(()=>scrollY);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*24}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await q.waitForTimeout(300);
 assert((await q.evaluate(()=>scrollY))>startY+30,'drag on divider should scroll page');
 assert.equal(await q.evaluate(()=>window.copiedDuringScroll),0);
 assert.equal(await inner.evaluate(e=>e.scrollTop),0);
 assert(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('PASS 48px mobile divider scrolls page without copying; continuation has no nested scroller or horizontal overflow');
 // Same source IDs are safe in another person's namespace.
 const second=await person(p,'Парижский автор','Париж');await ready(p);await upload(p,{...pack,posts:[{id:'post-001',text:'Autre texte'}]});await p.locator('#confirmPostsImport').click();await ready(p);
 assert(stored.custom_posts[second+'_post-001']);assert(stored.custom_posts[id+'_post-001']);
 assert((await p.locator('#accountClock').innerText()).includes('Париж 13:50'));
 // Concurrent offline additions merge by profile and post IDs, not as one replaceable library.
 await tick(q);await ready(q);offline=true;
 const tokyo=await person(p,'Токийский автор','Токио');const london=await person(q,'Лондонский автор','Лондон');
 await wait(p,()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'));
 await wait(q,()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'));
 offline=false;await tick(p);await tick(q);await ready(p);await ready(q);
 assert(stored.custom_people[tokyo]&&stored.custom_people[london]&&stored.custom_people[id]);
 await tick(q);await ready(q);
 assert.equal(await q.locator('#tabs [data-person]').count(),7);
 await p.locator(`#tabs [data-person="${id}"]`).click();await q.locator(`#tabs [data-person="${id}"]`).click();await wait(p,()=>document.getElementById('accountClock').textContent.includes('Москва'));await wait(q,()=>document.getElementById('accountClock').textContent.includes('Москва'));offline=true;
 await upload(p,{kind:'threads-posts',version:1,posts:[{id:'post-010',text:'Добавлено с компьютера'}]});await p.locator('#confirmPostsImport').click();
 await upload(q,{kind:'threads-posts',version:1,posts:[{id:'post-011',text:'Добавлено с телефона'}]});await q.locator('#confirmPostsImport').click();
 await wait(p,()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'));
 await wait(q,()=>document.getElementById('cloudStatus').textContent.includes('Нет связи'));
 offline=false;await tick(p);await tick(q);await ready(p);await ready(q);
 assert(stored.custom_posts[id+'_post-010']&&stored.custom_posts[id+'_post-011']);
 console.log('PASS separate characters and offline concurrent JSON imports merge without losing library entries');
 // Import help/template are available on each mini-page and do not contain credentials.
 await p.locator('#showJsonHelp').click();assert((await p.locator('#jsonInstructions').innerText()).includes('"kind": "threads-posts"'));
 assert(!(await p.locator('#jsonInstructions').innerText()).includes(KEY));assert((await p.locator('#jsonInstructions').innerText()).includes('Уже занятые ID')); 
 await p.screenshot({path:'/data/threads-desk/person-update/qa-help-desktop.png'});await p.locator('#closeJsonHelp').click();
 await p.screenshot({path:'/data/threads-desk/person-update/qa-profile-desktop.png'});
 await tick(q);await ready(q);await q.locator(`#tabs [data-person="${id}"]`).click();await q.evaluate(()=>scrollTo(0,0));
 await q.screenshot({path:'/data/threads-desk/person-update/qa-profile-mobile.png'});
 await q.locator('#addPerson').click();await q.screenshot({path:'/data/threads-desk/person-update/qa-add-mobile.png'});await q.locator('#closePerson').click();
 await q.locator('#showJsonHelp').click();await q.screenshot({path:'/data/threads-desk/person-update/qa-help-mobile.png'});await q.locator('#closeJsonHelp').click();
 await q.locator('#addPerson').click();await q.locator('#personName').fill('Ошибка города');await q.locator('#personCity').fill('Invalid/Mars');await q.locator('#personForm button[type=submit]').click();assert((await q.locator('#personError').innerText()).includes('Выберите город'));await q.screenshot({path:'/data/threads-desk/person-update/qa-city-error.png'});await q.locator('#closePerson').click();
 await q.locator('#settingsButton').click();assert(await q.locator('#settingsDialog').isVisible());await q.screenshot({path:'/data/threads-desk/person-update/qa-settings-mobile.png'});await q.locator('#closeSettings').click();
 assert.deepEqual(errors,[]);await browser.close();console.log('All people/import/mobile tests passed. No real cloud key used.');
})().catch(e=>{console.error(e);process.exit(1)});
