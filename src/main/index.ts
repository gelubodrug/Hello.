import { app, BrowserWindow, Menu, clipboard, dialog, safeStorage, protocol, net, nativeImage } from 'electron';
import { dirname, join, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { createDataStore } from './data/store';
import { ChatService } from './chat/service';
import type { BrowserHooks } from './chat/tools';
import { helloPiExtensionPath } from './chat/pi-session';
import { PiEngine } from './chat/pi-engine';
import { registerPiEngineIPC } from './chat/pi-engine-ipc';
import { MainTerminalService } from './terminal/service';
import type { TerminalSession } from '../shared/types';
import { createWorkerNotebookContext } from './terminal/notebook-context';
import { BrowserManager } from './browser/manager';
import { pageMenu } from './browser/context-menu';
import { appearanceGround } from './appearance';
import { LocalPreviewServer } from './browser/local-preview';
import { HtmlArtifacts } from './browser/html-artifacts';
import { PageModeController } from './browser/page-mode';
import { registerIPC } from './ipc';
import { disposeInOrder } from './lifecycle';
import { DshService } from './dsh/service';
import { DshSurface } from './dsh/surface';
import { dshLayout } from './dsh/layout';
import { bundledPnpm } from './dsh/pnpm';
import { utilitySpawn } from './dsh/electron-spawn';
import { registerDshIPC } from './dsh/ipc';
import { DshToolLink, dshToolsRow, isDshToolsRow, setDshToolsRow } from './dsh/tool-link';
import { McpManager } from './extensions/mcp';
import { ResourceLibrary } from './extensions/library';
import { SkillCatalog } from './extensions/skill-catalog';
import { registerSkillIPC } from './extensions/skill-ipc';
import { discoverSkills } from './extensions/discovery';
import { dshSkillRoots } from './dsh/skills';
import { cachedMarketHttp, createMarketHttp } from './market/net';
import { homedir } from 'node:os';
import { MarketService } from './market/service';
import { PiMarketService } from './market/pi-service';
import { registerMarketIPC } from './market/ipc';

/**
 * The panes a chat may see and speak to: its own terminals and CLI workers,
 * never another chat's. Ownership is checked here, in main, on every call —
 * a pane id the model kept from an earlier chat reaches nothing.
 */
function workerPanes(service:()=>MainTerminalService|null,announce:(session:TerminalSession)=>void){
  const own=(conversationId:string,paneId:string)=>{
    const session=service()?.list().find(item=>item.id===paneId&&item.conversationId===conversationId);
    if(!session)throw new Error('That pane is not open in this chat.');
    return session;
  };
  const seen=(session:TerminalSession)=>({id:session.id,title:session.title,...(session.workerId?{worker:session.workerId}:{}),folder:session.cwd,running:session.status==='running',...(session.exitCode===undefined?{}:{exitCode:session.exitCode})});
  return {
    list:(conversationId:string)=>(service()?.list()??[]).filter(item=>item.conversationId===conversationId).map(seen),
    installed:()=>(service()?.workers()??[]).filter(worker=>worker.installed).map(worker=>worker.id),
    start:async(conversationId:string,worker?:string)=>{
      const terminal=service();
      if(!terminal)throw new Error('Terminals are unavailable in this running app.');
      const session=await terminal.create(conversationId,worker as Parameters<MainTerminalService['create']>[1]);
      // A pane the model opened must be a pane the person can see.
      announce(session);
      return seen(session);
    },
    read:(conversationId:string,paneId:string,limit?:number)=>{
      const session=own(conversationId,paneId);
      const read=service()!.transcript(session.id,limit);
      return {...seen(read.session),text:read.text};
    },
    say:(conversationId:string,paneId:string,text:string)=>{
      own(conversationId,paneId);
      // Typing, Enter and then LOOKING: what comes back is what the screen shows.
      return service()!.submit(paneId,text);
    },
    key:(conversationId:string,paneId:string,key:string)=>{
      own(conversationId,paneId);
      return service()!.press(paneId,key as Parameters<MainTerminalService['press']>[1]);
    },
    wait:(conversationId:string,paneId:string,seconds:number)=>{
      own(conversationId,paneId);
      return service()!.waitFor(paneId,{seconds});
    },
    answer:(conversationId:string,paneId:string,askId:string,text:string)=>{
      own(conversationId,paneId);
      service()!.answerWorker(paneId,askId,text);
    },
  };
}
const bundleDir=dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.HELLO_DATA_DIR||join(app.getPath('appData'),'Hello Workspace');
if(!isAbsolute(dataDir))throw new Error('HELLO_DATA_DIR must be an absolute path.');
mkdirSync(dataDir,{recursive:true,mode:0o700});
app.setName('Hello.');
app.setPath('userData',dataDir);
protocol.registerSchemesAsPrivileged([{scheme:'hello',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
let mainWindow:BrowserWindow|null=null;
let cleanup:(()=>Promise<void>)|null=null;
let terminalService:MainTerminalService|null=null;
// A worker reports to the chat that opened it, and the chat is built after the
// terminals it reports through — so the link is read when a report arrives.
let chatService:ChatService|null=null;
let quitConfirmed=false;
let closing=false;

if(!app.requestSingleInstanceLock()){app.quit();}
else {
  app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
  app.whenReady().then(async()=>{
    const rendererRoot=resolve(bundleDir,'../renderer');
    protocol.handle('hello',request=>{
      const url=new URL(request.url);
      if(url.hostname!=='app')return new Response('Not found',{status:404});
      const resource=resolve(rendererRoot,`.${decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)}`);
      if(!resource.startsWith(rendererRoot+sep))return new Response('Forbidden',{status:403});
      return net.fetch(pathToFileURL(resource).href);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'Hello.',submenu:[{role:'about'},{type:'separator'},{role:'services'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      // The app's own keys (user, 04.10, the design audit): accelerators in the
      // menu reach the window wherever focus is — a page, a terminal — and the
      // window acts on them as on its buttons.
      {label:'File',submenu:[{label:'New Chat',accelerator:'CmdOrCtrl+N',click:()=>mainWindow?.webContents.send('hello:menu','new-chat')}]},
      {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'View',submenu:[{label:'Toggle Sidebar',accelerator:'CmdOrCtrl+B',click:()=>mainWindow?.webContents.send('hello:menu','toggle-sidebar')},{type:'separator'},{role:'reload'},{role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
      // Between chats from the keyboard, wherever focus is (S209): ⌘1–9 by place
      // in the list, ⌘⇧] and ⌘⇧[ next and previous, ⌘J the next one waiting.
      {label:'Go',submenu:[
        {label:'Go to…',accelerator:'CmdOrCtrl+Shift+P',click:()=>mainWindow?.webContents.send('hello:menu','go-to')},
        {type:'separator'},
        {label:'Next Chat',accelerator:'CmdOrCtrl+Shift+]',click:()=>mainWindow?.webContents.send('hello:menu','next-chat')},
        {label:'Previous Chat',accelerator:'CmdOrCtrl+Shift+[',click:()=>mainWindow?.webContents.send('hello:menu','previous-chat')},
        {label:'Next Waiting Chat',accelerator:'CmdOrCtrl+J',click:()=>mainWindow?.webContents.send('hello:menu','attention-chat')},
        {type:'separator'},
        ...[1,2,3,4,5,6,7,8,9].map(place=>({label:`Chat ${place}`,accelerator:`CmdOrCtrl+${place}`,click:()=>mainWindow?.webContents.send('hello:menu',`chat-${place}`)})),
      ]},
      {role:'windowMenu'},
    ]));
    const store=createDataStore(dataDir,{
      encrypt(value){if(!safeStorage.isEncryptionAvailable())throw new Error('Secure key storage is unavailable. No API key was saved.');return safeStorage.encryptString(value);},
      decrypt(value){if(!safeStorage.isEncryptionAvailable())throw new Error('Unlock the system keychain to use this API key.');return safeStorage.decryptString(value);},
    });
    // Acceptance runs start already connected: a probe should exercise the app,
    // not retype a connection through Settings first. Only the disposable test
    // mode reads these, and only while no connection has been saved yet.
    if(process.env.HELLO_TEST_MODE==='1'&&process.env.HELLO_TEST_ENDPOINT&&!store.getSettings().model){
      store.saveSettings({
        endpointUrl:process.env.HELLO_TEST_ENDPOINT,
        model:process.env.HELLO_TEST_MODEL??'',
        ...(process.env.HELLO_TEST_API_KEY?{apiKey:process.env.HELLO_TEST_API_KEY}:{}),
      });
    }
    // Its ground is the chosen appearance's from the first frame (audit B2).
    const window=new BrowserWindow({width:1440,height:960,minWidth:680,minHeight:540,title:'Hello.',backgroundColor:appearanceGround(store.getSettings().appearance),titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:18},show:false,webPreferences:{preload:join(bundleDir,'../preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:true}});
    mainWindow=window;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    // Closed until the browser manager exists, and then only for the guests it
    // owns: the handler below rewrites the guest's preferences before attach.
    let approveGuest:((preferences:Electron.WebPreferences,params:Record<string,string>)=>boolean)|null=null;
    window.webContents.on('will-attach-webview',(event,preferences,params)=>{
      if(!approveGuest?.(preferences,params))event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    const emit=(channel:string,event:unknown)=>{if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send(channel,event);};
    // Whether the person is in the app at all, for the chats waiting on them: a focused
    // page inside the window is still the window, and only the OS says otherwise.
    window.on('focus',()=>emit('hello:window-focus',true));
    window.on('blur',()=>emit('hello:window-focus',false));
    const unsubscribeNotebooks=store.subscribeNotebooks(event=>emit('hello:notebooks-changed',event));
    const browser=new BrowserManager({window,initial:store.listBrowserTabs(),conversationExists(id){try{store.getConversation(id);return true;}catch{return false;}},folderFor(id){try{return store.getConversation(id).folder;}catch{return null;}},downloadsFolder:()=>app.getPath('downloads'),initialDownloads:store.listBrowserDownloads(),saveDownload:download=>store.saveBrowserDownload(download),removeDownload:id=>store.deleteBrowserDownload(id),downloadEvent:event=>emit('hello:browser-download',event),save:tab=>store.saveBrowserTab(tab),remove:id=>store.deleteBrowserTab(id),emit:tab=>emit('hello:browser-update',tab),lifecycle:event=>emit('hello:browser-lifecycle',event),serve:(conversationId:string,source:string)=>serveSource(conversationId,source),contextMenu:(contents,params)=>{const items=pageMenu(params,{lookUp:()=>contents.showDefinitionForSelection(),cut:()=>contents.cut(),copy:()=>contents.copy(),paste:()=>contents.paste(),selectAll:()=>contents.selectAll(),copyText:text=>clipboard.writeText(text),copyImage:()=>contents.copyImageAt(params.x,params.y),saveImage:()=>contents.downloadURL(params.srcURL)});if(items.length&&!window.isDestroyed())Menu.buildFromTemplate(items).popup({window});}});
    // The DSH surface: dsh's own client, one page, in a partition of its own.
    // Its files ship in extraResources; in development they are the repo's assets.
    const dshResources=app.isPackaged?join(process.resourcesPath,'dsh'):[join(bundleDir,'..','..','assets','dsh'),join(process.cwd(),'assets','dsh')].find(candidate=>existsSync(candidate))??join(bundleDir,'..','..','assets','dsh');
    let reportBootFailure=(_entries:string[])=>{};
    const dshSurface=new DshSurface({openLink:url=>emit('hello:dsh-open-link',url),downloadsFolder:()=>app.getPath('downloads'),log:line=>console.log(line),onGone:reason=>console.warn(reason),onBootFailure:entries=>reportBootFailure(entries)});
    const dsh=new DshService({layout:dshLayout(dataDir,dshResources),hostEntry:join(bundleDir,'dsh-host.js'),spawn:utilitySpawn,surface:dshSurface,pnpm:bundledPnpm(),emit:status=>emit('hello:dsh-status',status),model:()=>{
      // The chat's own connection, read at each start and each proxied request.
      const settings=store.getSettings();
      if(!settings.endpointUrl||!settings.model)return undefined;
      let apiKey='';try{apiKey=store.getApiKey();}catch{/* a locked keychain proxies without a key */}
      return {endpointUrl:settings.endpointUrl,model:settings.model,apiKey,...(settings.contextWindow?{contextWindow:settings.contextWindow}:{}),...(settings.maxOutputTokens?{maxOutputTokens:settings.maxOutputTokens}:{})};
    }});
    reportBootFailure=entries=>dsh.reportBootFailure(entries);
    approveGuest=(preferences,params)=>browser.approveGuestAttach(preferences,params)||dshSurface.approveGuestAttach(preferences,params);
    window.webContents.on('did-attach-webview',(_event,guest)=>{if(!dshSurface.adoptGuest(guest))browser.adoptGuest(guest);});
    const pageModes=new PageModeController({pages:browser,dataDir,kinds:['design','annotate'],emit:event=>emit('hello:browser-mode',event)});
    const previews=new LocalPreviewServer();
    const artifactPreviews=new LocalPreviewServer();
    const artifacts=new HtmlArtifacts(dataDir);
    const serveArtifact=async(conversationId:string,id:string,signal?:AbortSignal)=>{
      signal?.throwIfAborted();
      store.getConversation(conversationId);
      const artifact=await artifacts.get(conversationId,id);
      signal?.throwIfAborted();
      const url=await artifactPreviews.open(conversationId,artifact.folder,artifact.path);
      signal?.throwIfAborted();
      store.getConversation(conversationId);
      return url;
    };
    const openArtifact=async(conversationId:string,id:string,signal?:AbortSignal)=>
      browser.agentShow(conversationId,await serveArtifact(conversationId,id,signal),signal,`artifact:${id}`);
    /** A page produced again from the handle its tab was saved by. */
    const serveSource=async(conversationId:string,source:string,signal?:AbortSignal)=>{
      if(source.startsWith('artifact:'))return serveArtifact(conversationId,source.slice('artifact:'.length),signal);
      const folder=store.getConversation(conversationId).folder;
      if(!folder)throw new Error('This chat no longer has the folder that page came from.');
      return previews.open(conversationId,folder,source);
    };
    const openInBrowser=async(conversationId:string,destination:string,signal?:AbortSignal)=>{
      signal?.throwIfAborted();
      if(destination.startsWith('artifact:'))return openArtifact(conversationId,destination.slice('artifact:'.length),signal);
      const local=!/^https?:/i.test(destination);
      let url=destination;
      if(local){
        const folder=store.getConversation(conversationId).folder;
        if(!folder)throw new Error('Attach the preview’s folder to this chat first.');
        url=await previews.open(conversationId,folder,destination);
        signal?.throwIfAborted();
        if(store.getConversation(conversationId).folder!==folder){
          previews.closeConversation(conversationId);
          throw new Error('The chat folder changed. Open the preview again.');
        }
      }
      // The model opens a page to work in it: the tab starts at Full (user, 29.09).
      return browser.agentOpen(conversationId,url,signal,{sessionOnly:local,isolated:local,grant:true,...(local?{source:destination}:{})});
    };
    const showHtmlInBrowser=async(conversationId:string,html:string,signal?:AbortSignal)=>{
      signal?.throwIfAborted();
      store.getConversation(conversationId);
      const created=await artifacts.create(conversationId,html,signal);
      const artifact=`artifact:${created.id}`;
      try {
        return {artifact,tab:await openArtifact(conversationId,created.id,signal)};
      } catch(error) {
        signal?.throwIfAborted();
        throw new Error(`HTML was saved as ${artifact}, but its preview could not be opened. Reopen this handle with browser_open; do not regenerate the document. ${error instanceof Error?error.message:'Preview unavailable.'}`);
      }
    };
    // One browser for the chat and for the CLIs opened in it (user, 30.09), behind the same per-tab gate.
    const browserHooks:BrowserHooks={open:openInBrowser,showHtml:showHtmlInBrowser,getTabs:id=>browser.listForAgent(id),read:(conversationId,id,signal)=>browser.read(id,conversationId,signal),navigate:(conversationId,id,url,signal)=>browser.agentNavigate(conversationId,id,url,signal),click:(conversationId,id,target,signal)=>browser.agentAction(conversationId,id,'click',target,'',signal),type:(conversationId,id,target,text,signal)=>browser.agentAction(conversationId,id,'type',target,text,signal),scroll:(conversationId,id,deltaY,signal)=>browser.agentAction(conversationId,id,'scroll',{},deltaY,signal),pointer:(conversationId,id,action,signal)=>browser.agentPointer(conversationId,id,action,signal),screenshot:(conversationId,id,request,signal)=>browser.agentScreenshot(conversationId,id,request,signal),mark:(conversationId,id,marks,signal)=>browser.agentMark(conversationId,id,marks,signal),download:(conversationId,id,url,signal)=>browser.agentDownload(conversationId,id,url,signal),downloads:conversationId=>browser.downloadsOf(conversationId),press:(conversationId,id,key,signal)=>browser.agentKey(conversationId,id,key,signal),wait:(conversationId,id,condition,signal)=>browser.agentWait(conversationId,id,condition,signal)};
    // The Pi chats run on: the bundled one, or an update installed from the sidebar.
    const piEngine=new PiEngine({root:join(dataDir,'pi'),pnpm:bundledPnpm(),emit:status=>emit('hello:pi-engine',status)});
    const terminal=new MainTerminalService({lookupConversation(id){try{return store.getConversation(id);}catch{return undefined;}},endpoint:()=>({...store.getSettings(),apiKey:store.getApiKey()}),notebookPaths:id=>store.notebookPaths(id),openNotebookContext:(conversationId,cwd)=>createWorkerNotebookContext({store,conversationId,cwd,userDataDir:dataDir,browser:browserHooks,piExtension:helloPiExtensionPath()}),userDataDir:dataDir,piCli:()=>join(dirname(piEngine.entry()),'cli.js'),emitData:event=>emit('hello:terminal-data',event),emitExit:event=>emit('hello:terminal-exit',event),onWorkerReport:event=>chatService?.workerReported(event)});
    terminalService=terminal;
    // The DSH surface's plugin tools reach chats as an MCP server reached in-process.
    const mcp=new McpManager(store,{links:row=>isDshToolsRow(row)?new DshToolLink(dsh):undefined});
    // Every skill on this Mac and in skills.sh's registry, for skills_find (user, 29.09).
    const library=new ResourceLibrary(store);
    const skillCatalog=new SkillCatalog({
      store,library,http:cachedMarketHttp(createMarketHttp()),stagingDir:join(dataDir,'skill-staging'),
      discover:()=>discoverSkills(process.env.HELLO_HOME_DIR||homedir(),store.listConversations().map(item=>item.folder).filter((folder): folder is string=>Boolean(folder)),dshSkillRoots(store.dataDir)),
    });
    library.remote=source=>skillCatalog.remote(source);
    const skills={
      search:(query:string,options:{online?:boolean;signal?:AbortSignal})=>skillCatalog.search(query,options),
      use:async(id:string,conversationId:string,signal?:AbortSignal)=>{const used=await skillCatalog.use(id,conversationId,signal);emit('hello:extensions-changed',{});return used;},
    };
    const chat=chatService=new ChatService({store,mcp,library,skillCatalog:skills,piEntry:()=>piEngine.entry(),emit:event=>emit('hello:chat-event',event),emitQueue:event=>emit('hello:chat-queue',event),emitExtensionUi:state=>emit('hello:chat-extension-ui',state),emitPending:state=>emit('hello:chat-pending',state),browser:browserHooks,workers:workerPanes(()=>terminalService,session=>emit('hello:terminal-created',session))});
    // Settle the selected model's published limits once at startup, so a
    // profile stored before this app knew how to ask still launches on the
    // model's real context window rather than the shipped default.
    void chat.settleModelLimits();
    const unregister=registerIPC(window,store,chat,terminal,browser,id=>previews.closeConversation(id),async id=>{
      artifactPreviews.closeConversation(id);
      await artifacts.removeConversation(id);
      await pageModes.removeConversation(id).catch(()=>{});
    },()=>emit('hello:extensions-changed',{}),pageModes);
    const unregisterPiEngine=registerPiEngineIPC(window,piEngine);
    // Newer Pi and dsh releases, asked of npm a moment after start and every few hours.
    const lookForUpdates=()=>{void piEngine.checkLatest().catch(()=>{});void dsh.checkLatest().catch(()=>{});};
    const firstUpdateLook=setTimeout(lookForUpdates,5_000);
    const updateLooks=setInterval(lookForUpdates,6*60*60_000);
    const unregisterDsh=registerDshIPC(window,dsh,dshSurface,{
      inLibrary:()=>Boolean(dshToolsRow(store)),
      set:async wanted=>{
        const before=dshToolsRow(store);
        setDshToolsRow(store,wanted);
        if(!wanted&&before)await chat.mcp.disconnect(before.id);
        emit('hello:extensions-changed',{});
        return Boolean(dshToolsRow(store));
      },
    });
    // The Community Plugin Market installs into the DSH profile; icons are re-encoded here, never loaded by the page.
    const normalizeIcon=(bytes:Buffer)=>{const image=nativeImage.createFromBuffer(bytes);return image.isEmpty()?null:image.resize({width:128,height:128,quality:'best'}).toDataURL();};
    const market=new MarketService({layout:dshLayout(dataDir,dshResources),pnpm:bundledPnpm(),log:line=>console.log(line),normalizeIcon});
    const unregisterMarket=registerMarketIPC(window,market);
    // The Pi package market (user, 29.09): the same window; a package installs
    // with pnpm into Hello's library, where each chat turns it on.
    const piMarket=new PiMarketService({store,library,pnpm:bundledPnpm(),stagingDir:join(dataDir,'pi-staging'),log:line=>console.log(line),normalizeIcon,changed:()=>emit('hello:extensions-changed',{})});
    library.packages={update:row=>piMarket.update(row)};
    const unregisterPiMarket=registerMarketIPC(window,piMarket,{channel:'piMarket'});
    const unregisterSkills=registerSkillIPC(window,skillCatalog,()=>emit('hello:extensions-changed',{}));
    cleanup=async()=>{
      cleanup=null;
      const failures=await disposeInOrder([
        {name:'IPC',dispose:unregister},
        {name:'DSH IPC',dispose:unregisterDsh},
        {name:'Pi engine IPC',dispose:()=>{clearTimeout(firstUpdateLook);clearInterval(updateLooks);unregisterPiEngine();}},
        {name:'market IPC',dispose:unregisterMarket},
        {name:'Pi market IPC',dispose:unregisterPiMarket},
        {name:'skills IPC',dispose:unregisterSkills},
        {name:'DSH surface',dispose:async()=>{dshSurface.dispose();await dsh.dispose();}},
        {name:'notebook events',dispose:unsubscribeNotebooks},
        {name:'chat',dispose:()=>chat.dispose()},
        {name:'terminals',dispose:()=>terminal.dispose()},
        {name:'page modes',dispose:()=>pageModes.dispose()},
        {name:'browser',dispose:()=>browser.dispose()},
        {name:'previews',dispose:()=>previews.dispose()},
        {name:'artifact previews',dispose:()=>artifactPreviews.dispose()},
        {name:'database',dispose:()=>store.close()},
      ]);
      if(failures.length)console.error('Hello. cleanup failed for:',failures.join(', '));
    };
    window.once('ready-to-show',()=>window.show());
    window.on('closed',()=>{mainWindow=null;app.quit();});
    window.on('close',event=>{
      if(closing){event.preventDefault();return;}
      const count=terminal.list().filter(item=>item.status==='running').length;
      event.preventDefault();
      if(count&&!quitConfirmed&&process.env.HELLO_TEST_MODE!=='1'){
        const choice=dialog.showMessageBoxSync(window,{type:'question',title:'Close Hello.?',message:`${count} terminal ${count===1?'session is':'sessions are'} still running.`,detail:'Closing the application will stop these processes. Your chats and notebooks are saved.',buttons:['Keep working','Quit and stop sessions'],defaultId:0,cancelId:0});
        if(choice===0)return;
      }
      quitConfirmed=true;closing=true;
      void (cleanup?.()||Promise.resolve()).finally(()=>{window.destroy();});
    });
    if(process.env.ELECTRON_RENDERER_URL)await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadURL('hello://app/index.html');
  }).catch(error=>{
    // A fast close can cancel the first load after the bridge is already usable.
    // That is normal shutdown, not a startup failure requiring a modal alert.
    if(closing)return;
    console.error('Hello. startup failed:',error instanceof Error?error.message:String(error));
    dialog.showErrorBox('Hello. could not start',error instanceof Error?error.message:'Unexpected startup error.');
    app.exit(1);
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{if(!mainWindow){terminalService?.dispose();void cleanup?.();}});
}
