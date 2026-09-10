import { app, ipcMain, dialog, shell, clipboard, ClipboardItem, type BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { DataStore } from './data/store';
import type { ChatService } from './chat/service';
import type { MainTerminalService } from './terminal/service';
import type { BrowserManager } from './browser/manager';
import { WorkspaceFiles } from './files/service';
import { resolveDropPaths } from './files/drop-paths';
import { discoverMcpServers, discoverSkills, withoutSecrets } from './extensions/discovery';
import type { NotebookKind, SettingsPatch, WorkerId, AgentControl, McpServerInput } from '../shared/types';

function str(value:unknown,label='ID',limit=500): string {
  if(typeof value!=='string'||value.length>limit||!value.trim())throw new Error(`Invalid ${label}.`);
  return value;
}
function record(value:unknown): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid request.');
  return value as Record<string,unknown>;
}
function kind(value:unknown):NotebookKind {if(value!=='runbook'&&value!=='tasks')throw new Error('Unknown notebook.');return value;}

export function registerIPC(window: BrowserWindow, store: DataStore, chat: ChatService, terminal: MainTerminalService, browser: BrowserManager, revokePreviews: (id: string) => void = () => {}, deleteArtifacts: (id: string) => Promise<void> = async () => {}, announceExtensions: ()=>void = () => {}): ()=>void {
  const registered: string[]=[];
  const files = new WorkspaceFiles(id => store.getConversation(id).folder);
  const handle=(name:string,run:(...args:any[])=>unknown)=>{
    const channel=`hello:${name}`;
    ipcMain.handle(channel,async(event,...args:unknown[])=>{
      // A remote page, subframe or another renderer never receives the app bridge.
      if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame)throw new Error('Untrusted IPC sender.');
      try{return await run(...args);}catch(error){
        let message=error instanceof Error?error.message:'The operation could not be completed.';
        const secrets=(()=>{try{return [store.getApiKey(),...store.allResourceSecrets()];}catch{return [] as string[];}})();
        // Model key and every configured MCP value, longest first.
        for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))
          message=message.split(secret).join('[redacted]');
        throw new Error(message);
      }
    });
    registered.push(channel);
  };
  handle('bootstrap',async()=>{const resources=await chat.library.list();return{conversations:store.listConversations(),settings:store.getSettings(),workers:terminal.workers(),terminals:terminal.list(),browsers:browser.list(),dataPath:store.dataDir,version:app.getVersion(),extensionsCount:resources.length};});
  handle('files.list', (id, path = '', search = '') => {
    if (typeof path !== 'string' || typeof search !== 'string' || search.length > 300) throw new Error('Invalid file filter.');
    return files.list(str(id), path, search);
  });
  handle('files.read', (id, path) => files.read(str(id), str(path, 'path', 8192)));
  handle('files.resolvePaths', (id, paths) => resolveDropPaths(store.getConversation(str(id)).folder, paths));
  handle('files.reveal', async (id, path) => { const target = await files.target(str(id), str(path, 'path', 8192)); shell.showItemInFolder(target.absolute); });
  handle('files.open', async (id, path) => {
    const target = await files.target(str(id), str(path, 'path', 8192));
    // Shell associations can execute scripts. A document link itself never invokes this action.
    if (!/\.(?:md|markdown|txt|json|ya?ml|toml|csv|pdf|png|jpe?g|gif|webp|heic|docx?|xlsx?|pptx?|rtf)$/i.test(target.absolute)) {
      const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Open this file outside Hello.?', detail: 'The default app may execute this file. Continue only if you trust it.', buttons: ['Cancel', 'Open file'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return;
    }
    const verified = await files.target(str(id), str(path, 'path', 8192));
    const error = await shell.openPath(verified.absolute);
    if (error) throw new Error(error);
  });
  handle('conversations.list',()=>store.listConversations());
  handle('conversations.create',(title)=>store.createConversation(title===undefined?undefined:str(title,'title',250)));
  handle('conversations.update',(id,value)=>{
    const conversationId=str(id);
    const patch=record(value);const clean:{title?:string;folder?:string|null;chatMode?:'chat'|'coder'}={};
    if(patch.title!==undefined)clean.title=str(patch.title,'title',250);
    if(patch.folder!==undefined){
      if(patch.folder===null)clean.folder=null;
      else {const folder=str(patch.folder,'folder',8192);if(!isAbsolute(folder)||!statSync(folder).isDirectory())throw new Error('Choose an existing folder.');clean.folder=folder;}
    }
    if(patch.chatMode!==undefined){
      if(patch.chatMode!=='chat'&&patch.chatMode!=='coder')throw new Error('Unknown chat mode.');
      if(chat.isRunning(conversationId))throw new Error('Stop the current response before changing chat mode.');
      clean.chatMode=patch.chatMode;
    }
    const previousFolder=store.getConversation(conversationId).folder;
    const updated=store.updateConversation(conversationId,clean);
    if(updated.folder!==previousFolder)revokePreviews(conversationId);
    return updated;
  });
  handle('conversations.delete',async(id)=>{id=str(id);await chat.deleteSession(id);for(const item of terminal.list())if(item.conversationId===id)terminal.close(item.id);browser.closeConversation(id);revokePreviews(id);await deleteArtifacts(id);store.deleteConversation(id);});
  handle('conversations.messages',(id)=>store.listMessages(str(id)));
  handle('conversations.export',async(id)=>{
    const conversation=store.getConversation(str(id));
    const result=await dialog.showSaveDialog(window,{title:'Export conversation',defaultPath:`${conversation.title.replace(/[^\p{L}\p{N} ._-]/gu,'').slice(0,80)||'Conversation'}.md`,filters:[{name:'Markdown',extensions:['md']}]});
    if(result.canceled||!result.filePath)return null;
    writeFileSync(result.filePath,store.exportConversation(id),'utf8');return result.filePath;
  });
  handle('settings.get',()=>store.getSettings());
  handle('settings.save',(value)=>{
    const patch=record(value);const clean:SettingsPatch={};
    for(const key of ['endpointUrl','model','apiKey','systemPrompt'] as const)if(patch[key]!==undefined){if(typeof patch[key]!=='string'||(patch[key] as string).length>100000)throw new Error(`Invalid ${key}.`);clean[key]=patch[key] as string;}
    if(patch.temperature!==undefined)clean.temperature=Number(patch.temperature);
    if(patch.reasoningEffort!==undefined)clean.reasoningEffort=patch.reasoningEffort as SettingsPatch['reasoningEffort'];
    if(patch.contextWindow!==undefined)clean.contextWindow=Number(patch.contextWindow);
    if(patch.maxOutputTokens!==undefined)clean.maxOutputTokens=Number(patch.maxOutputTokens);
    if(patch.modelCompatibility!==undefined)clean.modelCompatibility=patch.modelCompatibility as SettingsPatch['modelCompatibility'];
    if(patch.approvals!==undefined)clean.approvals=patch.approvals as SettingsPatch['approvals'];
    return store.saveSettings(clean);
  });
  handle('settings.rememberConnection',(name)=>store.rememberConnection(str(name)));
  handle('settings.useConnection',(url)=>store.useConnection(str(url)));
  handle('settings.forgetConnection',(url)=>store.forgetConnection(str(url)));
  handle('settings.models',()=>chat.models());
  handle('chat.attach',(id,paths)=>chat.attach(str(id),paths));
  handle('chat.send',(id,text,attachmentIds)=>{
    if(typeof text!=='string'||text.length>200000)throw new Error('Invalid message.');
    if(attachmentIds!==undefined&&(!Array.isArray(attachmentIds)||attachmentIds.length>8||attachmentIds.some(value=>typeof value!=='string'||value.length>100)))throw new Error('Invalid attachments.');
    return chat.send(str(id),text,attachmentIds);
  });
  handle('chat.stop',(id)=>chat.stop(str(id)));
  handle('chat.retry',(id)=>chat.retry(str(id)));
  handle('chat.approve',(id,allow)=>{if(typeof allow!=='boolean')throw new Error('Invalid approval.');return chat.approve(str(id),allow);});
  handle('notebooks.list',(id,type)=>store.listNotebooks(str(id),kind(type)));
  handle('notebooks.save',(value)=>{const input=record(value);if(typeof input.body!=='string'||typeof input.title!=='string')throw new Error('Notebook title and body must be text.');
    if(input.expectedUpdatedAt!==undefined&&(!Number.isSafeInteger(input.expectedUpdatedAt)||Number(input.expectedUpdatedAt)<0))throw new Error('Invalid notebook version.');
    return store.saveNotebook({...(input.id?{id:str(input.id)}:{}),conversationId:str(input.conversationId),kind:kind(input.kind),title:input.title,body:input.body,...(input.expectedUpdatedAt===undefined?{}:{expectedUpdatedAt:Number(input.expectedUpdatedAt)})});});
  handle('notebooks.delete',(id)=>store.deleteNotebook(str(id)));
  handle('notebooks.paths',(id)=>store.notebookPaths(str(id)));
  // ── Extensions: skills, plugins and MCP servers ───────────────────────────
  const resourceKind=(value:unknown):'skill'|'plugin'=>{
    if(value!=='skill'&&value!=='plugin')throw new Error('Choose a skill or a plugin.');
    return value;
  };
  // Examples ship with the app and import through the same path as any other
  // local folder: copied, inspected, never auto-activated.
  const examplesDirectory=()=>{
    // Packaged: extraResources. Development: the repository's assets folder,
    // resolved from this compiled file, because getAppPath() points at out/main.
    const candidates=app.isPackaged
      ?[join(process.resourcesPath,'examples')]
      :[join(dirname(fileURLToPath(import.meta.url)),'..','..','assets','examples'),
        join(app.getAppPath(),'..','..','assets','examples'),
        join(process.cwd(),'assets','examples')];
    return candidates.find(candidate=>existsSync(candidate))??candidates[0];
  };
  const exampleEntries=()=>{
    const root=examplesDirectory();
    const rows:Array<{kind:'skill'|'plugin';name:string;description:string}>=[];
    for(const kind of ['skill','plugin'] as const){
      const directory=join(root,`${kind}s`);
      if(!existsSync(directory))continue;
      for(const entry of readdirSync(directory,{withFileTypes:true})){
        if(!entry.isDirectory())continue;
        let description='';
        try{
          const manifest=kind==='skill'?join(directory,entry.name,'SKILL.md'):join(directory,entry.name,'package.json');
          const text=readFileSync(manifest,'utf8');
          description=kind==='skill'
            ?(/^description:\s*(.+)$/m.exec(text)?.[1]??'').trim().slice(0,300)
            :String((JSON.parse(text) as {description?:unknown}).description??'').slice(0,300);
        }catch{/* An example without readable metadata is still listed. */}
        rows.push({kind,name:entry.name,description});
      }
    }
    return rows;
  };
  handle('extensions.list',()=>chat.library.list());
  handle('extensions.examples',()=>exampleEntries());
  handle('extensions.importExample',async(kind,name)=>{
    const wanted=resourceKind(kind);
    const entry=exampleEntries().find(item=>item.kind===wanted&&item.name===str(name,'name',120));
    if(!entry)throw new Error('That example is not bundled with this build.');
    const imported=await chat.library.importPath(wanted,join(examplesDirectory(),`${wanted}s`,entry.name));
    announceExtensions();
    return imported;
  });
  handle('extensions.importResource',async(value)=>{
    const kind=resourceKind(value);
    const result=await dialog.showOpenDialog(window,{
      title:kind==='skill'?'Import a skill':'Import a plugin',
      message:kind==='skill'?'Choose a skill folder containing SKILL.md, or a single SKILL.md file.':'Choose a Pi package folder.',
      properties:kind==='skill'?['openDirectory','openFile']:['openDirectory'],
      ...(kind==='skill'?{filters:[{name:'Skill',extensions:['md']}]}:{}),
    });
    if(result.canceled||!result.filePaths[0])return null;
    // Import copies and inspects files; it never runs the imported code.
    const imported=await chat.library.importPath(kind,result.filePaths[0]);
    announceExtensions();
    return imported;
  });
  // HELLO_HOME_DIR lets the acceptance script point discovery at planted
  // configuration without moving HOME, which would cut the app off from the
  // keychain that encrypts stored values.
  const discoveryHome=()=>process.env.HELLO_HOME_DIR||homedir();
  // The folders this app's own chats are attached to are projects too.
  const discoveryProjects=()=>store.listConversations().map(item=>item.folder).filter((folder): folder is string=>Boolean(folder));
  handle('extensions.discover',async()=>{
    const [mcp,skills]=await Promise.all([discoverMcpServers(discoveryHome(),discoveryProjects()),discoverSkills(discoveryHome(),discoveryProjects())]);
    return {mcp:withoutSecrets(mcp),skills};
  });
  handle('extensions.importDiscovered',async(kind,id)=>{
    const wanted=str(kind,'kind',20);const wantedId=str(id,'id',8192);
    if(wanted==='skill'){
      const skill=(await discoverSkills(discoveryHome(),discoveryProjects())).find(item=>item.id===wantedId);
      if(!skill)throw new Error('That skill is no longer where it was found.');
      const imported=await chat.library.importPath('skill',skill.path);
      announceExtensions();
      return imported;
    }
    if(wanted!=='mcp')throw new Error('Only skills and MCP servers are discovered.');
    const server=(await discoverMcpServers(discoveryHome(),discoveryProjects())).find(item=>item.id===wantedId);
    if(!server)throw new Error('That server is no longer in that tool’s configuration.');
    if(server.transport!=='stdio')throw new Error(server.unsupported??'Hello connects to MCP servers over stdio.');
    const saved=chat.library.addMcp({name:server.name,command:server.command,args:server.args,env:server.env,cwd:server.cwd??null});
    announceExtensions();
    return saved;
  });
  handle('extensions.addMcp',async(value)=>{
    const input=record(value);
    if(!Array.isArray(input.args)||input.args.some(item=>typeof item!=='string'))throw new Error('Arguments must be a list of text values.');
    const env=input.env===undefined?{}:record(input.env);
    if(Object.values(env).some(item=>typeof item!=='string'))throw new Error('Environment values must be text.');
    const existing=typeof input.id==='string'&&input.id?str(input.id):undefined;
    const server:McpServerInput={
      ...(existing?{id:existing,keepEnv:input.keepEnv===true}:{}),
      name:str(input.name,'name',120),
      command:str(input.command,'command',4096),
      args:input.args as string[],
      env:env as Record<string,string>,
      cwd:input.cwd===undefined||input.cwd===null?null:str(input.cwd,'folder',8192),
    };
    if(server.cwd&&(!isAbsolute(server.cwd)||!statSync(server.cwd).isDirectory()))throw new Error('Choose an existing folder for the server.');
    const saved=chat.library.addMcp(server,existing);
    if(existing)await chat.mcp.disconnect(existing);
    announceExtensions();
    return saved;
  });
  handle('extensions.update',async(id)=>{
    const updated=await chat.library.update(str(id));
    announceExtensions();
    return updated;
  });
  handle('extensions.remove',async(id)=>{
    const removed=await chat.library.remove(str(id));
    if(removed.kind==='mcp')await chat.mcp.disconnect(removed.id);
    announceExtensions();
  });
  handle('extensions.active',(id)=>store.activeResourceIds(str(id)));
  handle('extensions.setActive',async(id,resourceId,active)=>{
    if(typeof active!=='boolean')throw new Error('Invalid activation.');
    const conversationId=str(id);
    const result=store.setResourceActive(conversationId,str(resourceId),active);
    // Turning a server off ends its process, not just its listing.
    if(!active)await chat.mcp.reconcile();
    announceExtensions();
    return result;
  });
  handle('extensions.status',()=>chat.mcp.status());
  handle('extensions.disconnect',async(id)=>{
    await chat.mcp.disconnect(str(id));
    announceExtensions();
  });
  handle('extensions.probe',async(id)=>{
    const status=await chat.mcp.probe(str(id));
    announceExtensions();
    return status;
  });
  handle('system.chooseFolder',async()=>{const result=await dialog.showOpenDialog(window,{title:'Choose this chat’s folder',properties:['openDirectory']});return result.canceled?null:result.filePaths[0]??null;});
  handle('system.openExternal',async(input)=>{const url=new URL(str(input,'link',8192));if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Only web links can be opened.');await shell.openExternal(url.href);});
  handle('system.copy',async(value)=>{
    const input=record(value);
    if(Object.keys(input).some(key=>key!=='text'&&key!=='html')||typeof input.text!=='string'||(input.html!==undefined&&typeof input.html!=='string'))throw new Error('Clipboard content must be text with optional formatted text.');
    const html=input.html as string|undefined;
    if(Buffer.byteLength(input.text,'utf8')+Buffer.byteLength(html??'','utf8')>16*1024*1024)throw new Error('This selection is too large to copy. Select a smaller part.');
    // Only the trusted app main frame reaches this handler. It is write-only;
    // website permissions and clipboard contents are never exposed to the agent.
    if(html!==undefined)await clipboard.write([new ClipboardItem({'text/plain':input.text,'text/html':html})]);
    else await clipboard.writeText(input.text);
  });
  handle('system.revealPath',(input)=>{
    const target=resolve(str(input,'path',8192));
    const allowed=[store.dataDir,...store.listConversations().flatMap(c=>c.folder?[c.folder]:[])];
    if(!allowed.some(folder=>target===folder||target.startsWith(folder+sep)))throw new Error('This path is outside the workspace.');
    shell.showItemInFolder(target);
  });
  handle('terminal.list',()=>terminal.list());
  handle('terminal.workers',()=>terminal.workers());
  handle('terminal.create',(id,worker)=>terminal.create(str(id),worker===undefined?undefined:str(worker,'worker') as WorkerId));
  handle('terminal.attach',(id)=>terminal.attach(str(id)));
  handle('terminal.write',(id,data)=>terminal.write(str(id),typeof data==='string'?data:(()=>{throw new Error('Invalid terminal input.');})()));
  handle('terminal.resize',(id,cols,rows)=>terminal.resize(str(id),cols,rows));
  handle('terminal.close',(id)=>terminal.close(str(id)));
  handle('browser.create',(id,url)=>browser.create(str(id),url===undefined?undefined:str(url,'address',8192)));
  handle('browser.navigate',(id,url)=>browser.navigate(str(id),str(url,'address',8192)));
  handle('browser.action',(id,action)=>{if(!['back','forward','reload','stop'].includes(action))throw new Error('Unknown browser action.');return browser.action(str(id),action);});
  handle('browser.setActive',(id)=>browser.setActive(id===null?null:str(id)));
  // The window asks for permission to create one page for one tab; everything
  // that page may do is decided in main when the guest attaches.
  handle('browser.attach',(id)=>browser.mintAttach(str(id)));
  handle('browser.detach',(id,nonce)=>browser.detach(str(id),nonce===undefined?undefined:str(nonce,'page',200)));
  handle('browser.control',(id,mode)=>browser.control(str(id),mode as AgentControl));
  handle('browser.read',(id)=>browser.read(str(id)));
  handle('browser.close',(id)=>browser.close(str(id)));
  return()=>{for(const channel of registered)ipcMain.removeHandler(channel);};
}
