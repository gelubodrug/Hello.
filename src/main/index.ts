import { app, BrowserWindow, Menu, dialog, safeStorage, protocol, net } from 'electron';
import { dirname, join, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createDataStore } from './data/store';
import { ChatService } from './chat/service';
import { MainTerminalService } from './terminal/service';
import { createWorkerNotebookContext } from './terminal/notebook-context';
import { BrowserManager } from './browser/manager';
import { LocalPreviewServer } from './browser/local-preview';
import { HtmlArtifacts } from './browser/html-artifacts';
import { PageModeController } from './browser/page-mode';
import { registerIPC } from './ipc';
import { disposeInOrder } from './lifecycle';

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
      {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'View',submenu:[{role:'reload'},{role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
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
    const window=new BrowserWindow({width:1440,height:960,minWidth:680,minHeight:540,title:'Hello.',backgroundColor:'#101112',titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:18},show:false,webPreferences:{preload:join(bundleDir,'../preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:true}});
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
    const unsubscribeNotebooks=store.subscribeNotebooks(event=>emit('hello:notebooks-changed',event));
    const browser=new BrowserManager({window,initial:store.listBrowserTabs(),conversationExists(id){try{store.getConversation(id);return true;}catch{return false;}},save:tab=>store.saveBrowserTab(tab),remove:id=>store.deleteBrowserTab(id),emit:tab=>emit('hello:browser-update',tab),lifecycle:event=>emit('hello:browser-lifecycle',event),serve:(conversationId:string,source:string)=>serveSource(conversationId,source)});
    approveGuest=(preferences,params)=>browser.approveGuestAttach(preferences,params);
    window.webContents.on('did-attach-webview',(_event,guest)=>browser.adoptGuest(guest));
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
      return browser.agentOpen(conversationId,url,signal,{sessionOnly:local,isolated:local,...(local?{source:destination}:{})});
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
    const terminal=new MainTerminalService({lookupConversation(id){try{return store.getConversation(id);}catch{return undefined;}},endpoint:()=>({...store.getSettings(),apiKey:store.getApiKey()}),notebookPaths:id=>store.notebookPaths(id),openNotebookContext:(conversationId,cwd)=>createWorkerNotebookContext({store,conversationId,cwd,userDataDir:dataDir}),userDataDir:dataDir,emitData:event=>emit('hello:terminal-data',event),emitExit:event=>emit('hello:terminal-exit',event)});
    terminalService=terminal;
    const chat=new ChatService({store,emit:event=>emit('hello:chat-event',event),emitQueue:event=>emit('hello:chat-queue',event),browser:{open:openInBrowser,showHtml:showHtmlInBrowser,getTabs:id=>browser.listForAgent(id),read:(conversationId,id,signal)=>browser.read(id,conversationId,signal),navigate:(conversationId,id,url,signal)=>browser.agentNavigate(conversationId,id,url,signal),click:(conversationId,id,selector,signal)=>browser.agentAction(conversationId,id,'click',selector,'',signal),type:(conversationId,id,selector,text,signal)=>browser.agentAction(conversationId,id,'type',selector,text,signal),scroll:(conversationId,id,deltaY,signal)=>browser.agentAction(conversationId,id,'scroll','',deltaY,signal)}});
    // Settle the selected model's published limits once at startup, so a
    // profile stored before this app knew how to ask still launches on the
    // model's real context window rather than the shipped default.
    void chat.settleModelLimits();
    const unregister=registerIPC(window,store,chat,terminal,browser,id=>previews.closeConversation(id),async id=>{
      artifactPreviews.closeConversation(id);
      await artifacts.removeConversation(id);
      await pageModes.removeConversation(id).catch(()=>{});
    },()=>emit('hello:extensions-changed',{}),pageModes);
    cleanup=async()=>{
      cleanup=null;
      const failures=await disposeInOrder([
        {name:'IPC',dispose:unregister},
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
