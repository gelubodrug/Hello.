/** Native integration acceptance. All writes use a new disposable app data directory. */
import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(),'hello-native-qa-'));
const artifacts = resolve('test-results');
const executablePath=process.env.HELLO_TEST_APP||require('electron');
const launchArgs=process.env.HELLO_TEST_APP?[]:[resolve('out/main/index.js')];
await mkdir(artifacts,{recursive:true});
const requests=[];
const server=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'hello-qa-model'},{id:'vendor/small:free'},{id:'vendor/large:free'}]}));return;}
  if(req.url==='/v1/chat/completions'){
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);requests.push(input);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const send=(delta,finish=null)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    // The engine appends a fresh context message after every turn, so the
    // message that says what this request is answering is the one before it.
    const last=input.messages.at(-2)??input.messages.at(-1);
    if(last?.role==='tool'){
      send({content:'## Ready to work\n\nThe shared notebook is available.\n\n```ts\nconst hello = "world";\n```\n\n| Layer | Status |\n| --- | --- |\n| Chat | Ready |\n\n- [x] Tool result received\n- [ ] Next task\n'});
      send({},'stop');res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:120,completion_tokens:85}})}\n\n`);res.end('data: [DONE]\n\n');
    }else if(JSON.stringify(last?.content ?? '').includes('slow test')){
      send({reasoning_content:'Checking the request…'});
      const timer=setInterval(()=>send({content:'Still streaming. '}),100);
      req.on('close',()=>clearInterval(timer));
      setTimeout(()=>{clearInterval(timer);if(!res.destroyed){send({},'stop');res.end('data: [DONE]\n\n');}},30000).unref();
    }else{
      send({reasoning_content:'I will inspect the shared notebook before answering.'});
      send({tool_calls:[{index:0,id:'call_qa_notebook',type:'function',function:{name:'notebook_list',arguments:'{"kind":'}}]});
      setTimeout(()=>{send({tool_calls:[{index:0,function:{arguments:'"runbook"}'}}]});send({},'tool_calls');res.end('data: [DONE]\n\n');},120);
    }
    return;
  }
  if(req.url==='/page'){
    res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><head><title>Hello QA Research</title></head><body style="font:18px system-ui;padding:50px;background:#f8f8f8"><h1>Research reference</h1><p id="finding">This is a local native-browser acceptance fixture.</p><input id="note" aria-label="Research note"><button id="save" onclick="document.getElementById(\'finding\').textContent=\'Recorded\'">Record</button></body></html>');return;
  }
  res.writeHead(404);res.end('Not found');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
let app;
const assertions=[];
async function closeApp(){
  const closingApp=app;
  if(!closingApp)return;
  app=null;
  let timer;
  try{
    await Promise.race([closingApp.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native application did not close within 15 seconds.')),15000);})]);
  }catch(error){closingApp.process().kill('SIGTERM');throw error;}
  finally{clearTimeout(timer);}
}
try{
  app=await electron.launch({executablePath,args:launchArgs,env:{...process.env,HELLO_DATA_DIR:dataDir,HELLO_TEST_MODE:'1',HELLO_TEST_ENDPOINT:`http://127.0.0.1:${port}/v1`,HELLO_TEST_MODEL:'hello-qa-model',ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();
  // Menus dismiss on window blur, and focusing a menu's search field in a window
  // the OS has not activated makes the window blur. Activate the app first, the
  // way a person's click would, so menu-driven steps are not racing focus.
  await app.evaluate(({app,BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
    try{app.focus({steal:true});}catch{/* not every platform activates on demand */}
  }).catch(()=>{});
  await page.bringToFront().catch(()=>{});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.hello);
  const bootstrap=await page.evaluate(()=>window.hello.bootstrap());
  assert.equal(bootstrap.conversations.length,0);
  assert.equal(bootstrap.dataPath,dataDir);
  assertions.push('New, isolated SQLite data directory');
  // The connection is already saved: the app was launched pointing at the
  // fixture. A probe should exercise the app, not retype its connection first.
  assert.equal(bootstrap.settings.endpointUrl,`http://127.0.0.1:${port}/v1`);
  assert.equal(bootstrap.settings.model,'hello-qa-model');
  assertions.push('The app starts on its saved connection with no trip through Settings');
  await page.evaluate(async({dataDir})=>{
    const chat=await window.hello.conversations.create('Research & handoff');
    await window.hello.conversations.update(chat.id,{folder:dataDir});
    await window.hello.notebooks.save({conversationId:chat.id,kind:'runbook',title:'Launch notes',body:'# Research & handoff\n\nKeep findings, decisions and useful references here.'});
    await window.hello.notebooks.save({conversationId:chat.id,kind:'tasks',title:'First steps',body:'- [ ] Review the findings\n- [ ] Implement the first task'});
  },{dataDir});
  // The chat, its folder and its notebooks were seeded behind the window, so
  // the renderer needs one reload to see them. This is the only reload left.
  await page.reload().catch(()=>page.reload());
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Review our notebook and prepare the next step.');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('heading',{name:'Ready to work',exact:true}).waitFor({timeout:20000});
  const state=await page.evaluate(async()=>{const boot=await window.hello.bootstrap();return {boot,messages:await window.hello.conversations.messages(boot.conversations[0].id)};});
  assert.equal(state.messages.length,2);
  assert.equal(state.messages[1].status,'complete');
  assert.ok(state.messages[1].parts.some(part=>part.type==='thinking'));
  assert.ok(state.messages[1].parts.some(part=>part.type==='tool'&&part.status==='complete'));
  assert.ok(requests.some(request=>request.messages.some(message=>message.role==='tool')));
  assertions.push('Real SSE stream → thinking + tool call/result + Markdown code/table/tasks, persisted');
  await page.locator('.code-line span[style*="color"]').first().waitFor({timeout:15000});
  assertions.push('Bundled Shiki highlights actual code under the production CSP');
  await page.screenshot({path:join(artifacts,'chat.png')});
  const id=state.boot.conversations[0].id;
  const paths=await page.evaluate(id=>window.hello.notebooks.paths(id),id);
  assert.match(await readFile(paths.runbook,'utf8'),/Launch notes/);
  assert.match(await readFile(paths.tasks,'utf8'),/Review the findings/);
  assertions.push('Distinct, durable runbook/tasks Markdown files without prompt injection');
  const terminal=await page.evaluate(id=>window.hello.terminal.create(id),id);
  await page.evaluate(id=>window.hello.terminal.write(id,"printf 'HELLO_PTY_OK\\n'; pwd\n"),terminal.id);
  await page.waitForFunction(async id=>(await window.hello.terminal.attach(id)).scrollback.includes('HELLO_PTY_OK'),terminal.id);
  const attached=await page.evaluate(id=>window.hello.terminal.attach(id),terminal.id);
  assert.match(attached.scrollback,/HELLO_PTY_OK/);assert.equal(attached.session.cwd,dataDir);
  assertions.push('Native PTY starts in chat folder, input/output and bounded replay work');
  // An empty tab must be able to navigate: its page exists behind the start
  // screen, which is what the address bar loads into.
  const empty=await page.evaluate(id=>window.hello.browser.create(id),id);
  await page.evaluate(async({id,port})=>window.hello.browser.navigate(id,`http://127.0.0.1:${port}/page`),{id:empty.id,port});
  await page.waitForFunction(async id=>(await window.hello.bootstrap()).browsers.find(tab=>tab.id===id)?.url?.includes('/page'),empty.id);
  await page.evaluate(id=>window.hello.browser.close(id),empty.id);
  assertions.push('A new empty tab navigates from its start screen');
  const browser=await page.evaluate(({id,port})=>window.hello.browser.create(id,`http://127.0.0.1:${port}/page`),{id,port});
  await page.evaluate(async({id,port})=>window.hello.browser.navigate(id,`http://127.0.0.1:${port}/page`),{id:browser.id,port});
  await assert.rejects(()=>page.evaluate(id=>window.hello.browser.read(id),browser.id),/Off/);
  await page.evaluate(id=>window.hello.browser.control(id,'read'),browser.id);
  const content=await page.evaluate(id=>window.hello.browser.read(id),browser.id);
  assert.match(content.text,/local native-browser acceptance fixture/);
  assert.equal(content.title,'Hello QA Research');
  assertions.push('Native Chromium page + main-process Off/read permission enforcement');
  await page.reload();
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await page.getByRole('button',{name:'Open tools',exact:true}).click();
  await page.getByRole('tab',{name:'Hello QA Research',exact:true}).click();
  await page.getByRole('textbox',{name:'Web address',exact:true}).waitFor();
  await page.waitForTimeout(600);
  // The page is a document element now, so the app owns no native child views
  // and the guest is hosted by this window rather than stacked above it.
  const hosting=await app.evaluate(({BrowserWindow,webContents})=>{
    const window=BrowserWindow.getAllWindows()[0];
    return {
      nativeChildren:window.contentView.children.length,
      guests:webContents.getAllWebContents().filter(contents=>contents.getType()==='webview')
        .map(contents=>({hosted:contents.hostWebContents===window.webContents,url:contents.getURL()})),
    };
  });
  assert.equal(hosting.nativeChildren,0,'No native child view may remain in the window');
  assert.equal(hosting.guests.length,1,`Exactly one page guest expected, saw ${JSON.stringify(hosting.guests)}`);
  assert.equal(hosting.guests[0].hosted,true,'The page must be hosted by this window');
  // The page sits in its own host, positioned onto the pane's viewport.
  // Settle any pane motion before comparing: the host follows its slot on the
  // next frame, so a measurement taken mid-animation proves nothing.
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(200);
  const viewport=await page.evaluate(()=>{
    const host=document.querySelector('.browser-guest-host');
    const slot=document.querySelector('.tool-host:not([hidden]) .browser-viewport');
    if(!host||!slot||!host.querySelector('webview'))return null;
    const page=host.getBoundingClientRect();
    const pane=slot.getBoundingClientRect();
    return{width:page.width,height:page.height,
      page:{x:Math.round(page.x),y:Math.round(page.y),w:Math.round(page.width)},
      pane:{x:Math.round(pane.x),y:Math.round(pane.y),w:Math.round(pane.width)},
      onPane:Math.abs(page.x-pane.x)<2&&Math.abs(page.y-pane.y)<2&&Math.abs(page.width-pane.width)<2};
  });
  assert.ok(viewport&&viewport.width>300&&viewport.height>100,`The page element must fill its pane, saw ${JSON.stringify(viewport)}`);
  assert.equal(viewport.onPane,true,`The page must sit exactly on its pane’s viewport, saw ${JSON.stringify(viewport)}`);
  assertions.push('The page is a document guest of this window, with no native child views left');
  const footprint=[];
  for(const mode of ['off','read','full']){
    await page.evaluate(({id,mode})=>window.hello.browser.control(id,mode),{id:browser.id,mode});
    footprint.push(await page.locator('.agent-control-pill:visible').boundingBox());
  }
  // The size itself is a design choice; what must hold is that switching mode
  // never resizes the control and moves the toolbar around it.
  assert.ok(footprint.every(rect=>rect&&rect.width>0&&rect.height>0),'Agent control pill must stay visible in every mode');
  assert.ok(footprint.every(rect=>rect.width===footprint[0].width&&rect.height===footprint[0].height),
    `Agent control pill changes size between modes: ${JSON.stringify(footprint)}`);
  assertions.push(`Agent control pill keeps one ${footprint[0].width} × ${footprint[0].height} footprint in all three modes`);
  await page.getByRole('button',{name:'AI Mode: Full access',exact:true}).click();
  await page.getByRole('menu',{name:'AI Mode',exact:true}).waitFor();
  await page.waitForTimeout(300);
  // The case the old build had to work around by hiding the page: a menu that
  // overlaps it. Now the menu simply wins the hit test and the page stays up.
  const overMenu=await page.evaluate(()=>{
    const menu=document.querySelector('[role="menu"]:not([aria-hidden])');
    const guest=document.querySelector('.browser-guest-host');
    if(!menu||!guest)return{menu:Boolean(menu),guest:Boolean(guest)};
    const menuRect=menu.getBoundingClientRect();
    const guestRect=guest.getBoundingClientRect();
    const hit=document.elementFromPoint(menuRect.left+menuRect.width/2,menuRect.top+menuRect.height/2);
    return{
      menuRect:{x:Math.round(menuRect.x),y:Math.round(menuRect.y),w:Math.round(menuRect.width),h:Math.round(menuRect.height)},
      guestRect:{x:Math.round(guestRect.x),y:Math.round(guestRect.y),w:Math.round(guestRect.width),h:Math.round(guestRect.height)},
      overlaps:menuRect.left<guestRect.right&&menuRect.right>guestRect.left&&
        menuRect.top<guestRect.bottom&&menuRect.bottom>guestRect.top,
      hitIsMenu:Boolean(hit&&menu.contains(hit)),
      pageStillVisible:guestRect.width>0&&guestRect.height>0,
    };
  });
  assert.equal(overMenu.overlaps,true,`This assertion is only meaningful while the menu covers part of the page: ${JSON.stringify(overMenu)}`);
  assert.equal(overMenu.hitIsMenu,true,'The menu must be above the page, not behind it');
  assert.equal(overMenu.pageStillVisible,true,'The page must stay visible while a menu is open');
  assert.equal(await app.evaluate(({webContents})=>webContents.getAllWebContents().filter(contents=>contents.getType()==='webview').length),1,
    'The page must not be destroyed or replaced while a menu is open');
  await page.screenshot({path:join(artifacts,'browser-menu.png')});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assertions.push('A menu paints over the page it overlaps, and the page stays open behind it');
  if(process.env.HELLO_QA_HOLD==='1'){
    console.log('QA_WINDOW_READY: native browser visible for inspection (60 seconds).');
    await page.waitForTimeout(60000);
  }
  await page.getByRole('button',{name:'Close chat',exact:true}).click();
  await page.getByRole('button',{name:'Open Chat',exact:true}).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({path:join(artifacts,'tools-expanded.png')});
  await page.getByRole('button',{name:'Open Chat',exact:true}).click();
  await page.getByRole('tab',{name:'Terminal',exact:true}).click();
  await page.locator('.hello-terminal .xterm, .terminal-pane .xterm, .xterm').first().waitFor();
  await page.screenshot({path:join(artifacts,'terminal.png')});
  if(process.env.HELLO_QA_WORKER){
    const worker=await page.evaluate(({id,workerId})=>window.hello.terminal.create(id,workerId),{id,workerId:process.env.HELLO_QA_WORKER});
    await page.waitForFunction(async workerId=>(await window.hello.terminal.attach(workerId)).scrollback.length>20,worker.id,{timeout:15000});
    const workerState=await page.evaluate(workerId=>window.hello.terminal.attach(workerId),worker.id);
    assert.equal(workerState.session.kind,'worker');
    assert.equal(workerState.session.cwd,dataDir);
    assert.equal(workerState.session.status,'running');
    await page.reload();
    await page.getByRole('tab',{name:worker.title,exact:true}).click();
    await page.waitForTimeout(400);
    await page.screenshot({path:join(artifacts,'cli-worker.png')});
    await page.evaluate(workerId=>window.hello.terminal.close(workerId),worker.id);
    assertions.push(`Installed ${worker.title} starts in a real PTY; no task or trust approval submitted`);
  }
  await page.getByRole('button',{name:'Close tools',exact:true}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('slow test');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop response',exact:true}).click();
  await page.waitForFunction(async id=>(await window.hello.conversations.messages(id)).at(-1)?.status!=='streaming',id);
  assertions.push('Stop cancels a real streaming request and persists its state');

  // Settings last: it is the only step that needs the dialog, so a problem in
  // it cannot block everything the app actually does.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Save connection & load models',exact:true}).click();
  // Wait for the save AND the model load to finish. Opening the menu while that
  // is still in flight races the re-render that fills it.
  await page.locator('.settings-saved').getByText('Saved',{exact:true}).waitFor();
  // The search field takes focus as it mounts, and in a window the OS has not
  // activated that focus change blurs the window, which dismisses any menu.
  // Driving the whole interaction inside the page keeps every assertion — the
  // placeholder, the filtering, the stacking above Settings and what Escape
  // closes — without a round trip in the middle for the blur to land in.
  const search=await page.evaluate(async()=>{
    const settleFrames=()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    document.querySelector('button[aria-label="Available models"]').click();
    await settleFrames();
    const input=document.querySelector('input[aria-label="Search models"]');
    if(!input)return{error:'The model menu has no search field.'};
    const rect=input.getBoundingClientRect();
    const onTop=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===input;
    const placeholder=input.placeholder;
    const write=value=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    };
    write('free');
    await settleFrames();
    const items=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(node=>node.textContent.trim());
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await settleFrames();
    // A dismissed menu stays mounted for its exit animation, marked aria-hidden.
    const afterEscape={menus:document.querySelectorAll('[role="menu"]:not([aria-hidden])').length,dialog:Boolean(document.querySelector('[role="dialog"]'))};
    document.querySelector('button[aria-label="Available models"]').click();
    await settleFrames();
    const reopenedQuery=document.querySelector('[role="menu"]:not([aria-hidden]) input[aria-label="Search models"]')?.value;
    return{placeholder,onTop,items,afterEscape,reopenedQuery};
  });
  assert.equal(search.error,undefined,String(search.error));
  assert.equal(search.placeholder,'search models try "free"');
  assert.ok(search.onTop,'Search input must be above Settings, not occluded');
  assert.ok(search.items.length&&search.items.every(label=>label.includes('free')),
    `Filtering must leave only matching models, saw ${JSON.stringify(search.items)}`);
  assert.ok(!search.items.some(label=>label.includes('aion-labs')),'A non-matching model must be filtered out');
  assert.equal(search.afterEscape.menus,0,'Escape must close the menu');
  assert.equal(search.afterEscape.dialog,true,'Escape must not close Settings');
  assert.equal(search.reopenedQuery,'','Reopening the menu must start from an empty query');
  await page.waitForTimeout(150);
  await page.screenshot({path:join(artifacts,'models-search.png')});
  await page.getByRole('button',{name:'Back',exact:true}).click();
  assertions.push('Searchable model list filters free above Settings; Escape closes only its menu');
  await page.evaluate(id=>window.hello.terminal.close(id),terminal.id);
  assert.equal(errors.length,0,errors.join('\n'));
  const recorded=await page.evaluate(id=>window.hello.conversations.messages(id),id);
  await closeApp();
  app=await electron.launch({executablePath,args:launchArgs,env:{...process.env,HELLO_DATA_DIR:dataDir,HELLO_TEST_MODE:'1',HELLO_TEST_ENDPOINT:`http://127.0.0.1:${port}/v1`,HELLO_TEST_MODEL:'hello-qa-model',ELECTRON_RUN_AS_NODE:undefined}});
  const reopened=await app.firstWindow();
  const after=await reopened.evaluate(async id=>({messages:await window.hello.conversations.messages(id),boot:await window.hello.bootstrap()}),id);
  assert.equal(after.messages.length,recorded.length);
  assert.equal(after.boot.browsers[0].control,'off');
  assert.equal(after.boot.terminals.length,0);
  assertions.push('Restart preserves chats/notebooks/browser metadata; grants reset Off, no processes autostart');
  await closeApp();
  assertions.push('Fast close immediately after restart completes without a modal or orphaned app');
  const report={passed:true,assertions,dataDir,requests:requests.length};
  await writeFile(join(artifacts,process.env.HELLO_TEST_APP?'packaged-smoke.json':'native-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}catch(error){
  if(app){try{const page=await app.firstWindow();await page.screenshot({path:join(artifacts,'failure.png')});}catch{}}
  console.error(error);process.exitCode=1;
}finally{if(app)await closeApp().catch(error=>{console.error(error);process.exitCode=1;});server.closeAllConnections();server.close();}
