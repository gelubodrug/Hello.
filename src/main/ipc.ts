import { app, ipcMain, dialog, shell, clipboard, ClipboardItem, Notification, systemPreferences, type BrowserWindow } from 'electron';
import { applyAppearance } from './appearance';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { DataStore } from './data/store';
import type { ChatService } from './chat/service';
import type { MainTerminalService } from './terminal/service';
import type { BrowserManager } from './browser/manager';
import type { PageModeController } from './browser/page-mode';
import { WorkspaceFiles } from './files/service';
import { DEFAULT_TTS_VOICE, SPEECH_TEXT_LIMIT, VoiceSpeaker } from './voice/speak';
import { translateVoice, voiceAudio } from './voice/translate';
import type { ManagedVoice } from './voice/managed';
import { resolveDropPaths } from './files/drop-paths';
import { discoverMcpServers, discoverPiExtensions, discoverSkills, withoutSecrets } from './extensions/discovery';
import { dshSkillRoots } from './dsh/skills';
import type { NotebookKind, SettingsPatch, WorkerId, AgentControl, McpServerInput, PageRect } from '../shared/types';

function str(value:unknown,label='ID',limit=500): string {
  if(typeof value!=='string'||value.length>limit||!value.trim())throw new Error(`Invalid ${label}.`);
  return value;
}
function record(value:unknown): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid request.');
  return value as Record<string,unknown>;
}
function kind(value:unknown):NotebookKind {if(value!=='runbook'&&value!=='tasks'&&value!=='plan')throw new Error('Unknown notebook.');return value;}

export function registerIPC(window: BrowserWindow, store: DataStore, chat: ChatService, terminal: MainTerminalService, browser: BrowserManager, revokePreviews: (id: string) => void = () => {}, deleteArtifacts: (id: string) => Promise<void> = async () => {}, announceExtensions: ()=>void = () => {}, pageModes?: PageModeController, managedVoice?: ManagedVoice): ()=>void {
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
  handle('files.searchContents', (id, requestId, query, options = {}) => {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 300 || /[\u0000-\u001f]/.test(query)) throw new Error('Search for 2 to 300 characters on one line.');
    const { matchCase = false } = record(options);
    if (typeof matchCase !== 'boolean') throw new Error('Invalid request.');
    return files.searchContents(str(id), str(requestId, 'request', 100), query, matchCase);
  });
  handle('files.cancelSearch', id => files.cancelSearch(str(id)));
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
    const patch=record(value);const clean:{title?:string;folder?:string|null;chatMode?:'chat'|'coder';planning?:boolean;runbook?:boolean;tasks?:boolean;model?:{endpointUrl:string;id:string}|null}={};
    // The model the chat runs on, picked in its composer (user, 04.10); its next turn takes it.
    if(patch.model!==undefined){
      if(patch.model===null)clean.model=null;
      else {const model=record(patch.model);clean.model={endpointUrl:str(model.endpointUrl,'endpoint',2048),id:str(model.id,'model',500)};}
    }
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
    // A section switches while a reply runs too (user, 30.09: Plans would not
    // turn on mid-reply). Its tools follow from the next step, a tool call
    // checks the switch when it runs, and the next turn's instructions match.
    if(patch.planning!==undefined){
      if(typeof patch.planning!=='boolean')throw new Error('Planning is on or off.');
      clean.planning=patch.planning;
    }
    for(const page of ['runbook','tasks'] as const){
      if(patch[page]===undefined)continue;
      if(typeof patch[page]!=='boolean')throw new Error(`${page} is on or off.`);
      clean[page]=patch[page] as boolean;
    }
    const previousFolder=store.getConversation(conversationId).folder;
    const updated=store.updateConversation(conversationId,clean);
    if(updated.folder!==previousFolder)revokePreviews(conversationId);
    return updated;
  });
  handle('conversations.delete',async(id)=>{id=str(id);await chat.deleteSession(id);for(const item of terminal.list())if(item.conversationId===id)terminal.close(item.id);browser.closeConversation(id);revokePreviews(id);await deleteArtifacts(id);store.deleteConversation(id);});
  handle('conversations.restart',(id)=>chat.restart(str(id)));
  handle('conversations.search',(query)=>store.searchMessages(typeof query==='string'?query.slice(0,200):''));
  handle('conversations.reset',(id,options)=>{const input=options===undefined||options===null?{}:record(options);if(input.notes!==undefined&&typeof input.notes!=='boolean')throw new Error('notes must be true or false.');return chat.reset(str(id),{notes:input.notes!==false});});
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
    if(patch.appearance!==undefined){if(!['system','light','dark'].includes(patch.appearance as string))throw new Error('Appearance is System, Light or Dark.');clean.appearance=patch.appearance as SettingsPatch['appearance'];}
    if(patch.subagentModel!==undefined){if(typeof patch.subagentModel!=='string'||patch.subagentModel.length>500)throw new Error('Invalid subagent model.');clean.subagentModel=patch.subagentModel;}
    if(patch.voice!==undefined){
      const voice=record(patch.voice);
      if(voice.enabled!==undefined&&typeof voice.enabled!=='boolean')throw new Error('Invalid voice setting.');
      const fields=['sttEndpointUrl','sttModel','sourceLanguage','ttsEndpointUrl','ttsVoice'] as const;
      for(const key of fields)if(voice[key]!==undefined&&(typeof voice[key]!=='string'||(voice[key] as string).length>500))throw new Error('Invalid voice setting.');
      const current=store.getSettings().voice;
      clean.voice={enabled:voice.enabled===undefined?current?.enabled===true:voice.enabled===true};
      for(const key of fields)if(voice[key]!==undefined)clean.voice[key]=voice[key] as string;
    }
    const saved=store.saveSettings(clean);
    // The app's look follows at once: native menus, and what pages read as prefers-color-scheme.
    if(clean.appearance!==undefined)applyAppearance(window,saved.appearance);
    // A new selection asks the provider what this model holds, in the background:
    // saving must not wait on a network round trip, and the next turn awaits it.
    if(clean.model!==undefined||clean.endpointUrl!==undefined)void chat.settleModelLimits();
    return saved;
  });
  handle('settings.rememberConnection',(name)=>store.rememberConnection(str(name)));
  handle('settings.useConnection',(url)=>{const saved=store.useConnection(str(url));void chat.settleModelLimits();return saved;});
  handle('settings.forgetConnection',(url)=>store.forgetConnection(str(url)));
  handle('settings.models',(url)=>chat.models(url===undefined?undefined:str(url,'endpoint',2000)));
  handle('settings.catalog',()=>chat.catalog());
  handle('settings.usage',()=>store.usageSummary());
  handle('settings.localServers',()=>chat.localServers(true));
  // The same look Settings just asked for: a voice server is found, never started.
  handle('settings.voiceServers',()=>chat.voiceServers());
  handle('workspace.toolOrder',id=>store.toolOrder(str(id)));
  handle('workspace.saveToolOrder',(id,order)=>store.saveToolOrder(str(id),order));
  // A chunk of a reply, read aloud by the speech server the person runs here:
  // the one Settings names, else the first one found. Never one off this Mac.
  const speaker=new VoiceSpeaker();
  handle('voice.status',()=>managedVoice?.status());
  handle('voice.prepare',async(consent)=>{
    if(consent!==true)throw new Error('Click Install Voice to approve the displayed downloads.');
    if(!managedVoice)throw new Error('Restart Hello. to enable automatic Voice installation.');
    const status=await managedVoice.prepare(true);
    const settings=store.saveSettings({voice:{enabled:true}});
    return {status,settings};
  });
  handle('voice.cancel',()=>managedVoice?.cancel());
  handle('voice.stopSpeech',()=>managedVoice?.cancelSpeech());
  let translating=false;
  handle('voice.translate',async(audio)=>{
    const bytes=voiceAudio(audio);
    const voice=store.getSettings().voice;
    if(!voice?.enabled)throw new Error('Turn Voice on before speaking.');
    if(translating)throw new Error('A voice turn is already being translated.');
    translating=true;
    try{
      const server=managedVoice?await managedVoice.translationEndpoint():voice.sttEndpointUrl||(await chat.voiceServers()).find(found=>found.kind==='whisper.cpp')?.baseUrl;
      if(!server)throw new Error('No speech-to-text server is running on this Mac.');
      return await translateVoice(server,bytes,{model:voice.sttModel,language:voice.sourceLanguage});
    }finally{translating=false;}
  });
  handle('voice.speak',async(text)=>{
    const words=str(text,'text',SPEECH_TEXT_LIMIT);
    const voice=store.getSettings().voice;
    if(!voice?.enabled)throw new Error('Turn Voice on to hear replies.');
    const server=managedVoice?await managedVoice.speechEndpoint():voice?.ttsEndpointUrl||(await chat.voiceServers()).find(found=>found.kind==='speech')?.baseUrl;
    if(managedVoice&&!server)return managedVoice.speak(words,voice?.ttsVoice??DEFAULT_TTS_VOICE);
    if(!server)throw new Error('No voice server is running on this Mac.');
    return speaker.speak(server,words,voice?.ttsVoice??DEFAULT_TTS_VOICE,managedVoice?.speechSignal);
  });
  // What macOS says about the microphone, read without asking: the ask is the
  // first voice turn's, through the window's media grant.
  handle('voice.microphone',()=>process.platform==='darwin'?systemPreferences.getMediaAccessStatus('microphone'):'granted');
  handle('chat.attach',(id,paths)=>chat.attach(str(id),paths));
  // What every chat waits for the person to answer (audit A1): read-only.
  handle('chat.pendingInput',()=>chat.pendingInput());
  // A picture pasted into the composer (S209): read here, in main, only when the
  // person pastes, so its bytes never pass through the window and are never logged.
  handle('chat.attachClipboard',async(id)=>{
    // Electron 44's clipboard is the W3C one: the picture is an item's image/png.
    const item=(await clipboard.read()).find(entry=>entry.types.includes('image/png'));
    if(!item)throw new Error('There is no picture on the clipboard.');
    const picture=await item.getType('image/png');
    if(!(picture instanceof Blob))throw new Error('There is no picture on the clipboard.');
    return chat.attachData(str(id),[{name:`Pasted image ${new Date().toISOString()}.png`,bytes:Buffer.from(await picture.arrayBuffer())}]);
  });
  handle('chat.previewAttachment',(id,attachmentId)=>chat.previewAttachment(str(id),str(attachmentId)));
  handle('chat.send',(id,text,attachmentIds)=>{
    if(typeof text!=='string'||text.length>200000)throw new Error('Invalid message.');
    if(attachmentIds!==undefined&&(!Array.isArray(attachmentIds)||attachmentIds.length>8||attachmentIds.some(value=>typeof value!=='string'||value.length>100)))throw new Error('Invalid attachments.');
    return chat.send(str(id),text,attachmentIds);
  });
  handle('chat.queue',(id,text,mode)=>{
    if(typeof text!=='string'||text.length>200000)throw new Error('Invalid message.');
    if(mode!=='steer'&&mode!=='next'&&mode!=='later')throw new Error('Unknown delivery.');
    return chat.queue(str(id),text,mode);
  });
  handle('chat.queued',(id)=>chat.listQueued(str(id)));
  handle('chat.reviseQueued',(id,patch)=>{
    const value=record(patch);const clean:{text?:string;mode?:'steer'|'next'|'later'}={};
    if(value.text!==undefined){if(typeof value.text!=='string'||value.text.length>200000)throw new Error('Invalid message.');clean.text=value.text;}
    if(value.mode!==undefined){if(value.mode!=='steer'&&value.mode!=='next'&&value.mode!=='later')throw new Error('Unknown delivery.');clean.mode=value.mode;}
    return chat.reviseQueued(str(id,'id',200),clean);
  });
  handle('chat.dropQueued',(id,conversationId)=>chat.dropQueued(str(id,'id',200),conversationId===undefined?undefined:str(conversationId)));
  handle('chat.stop',(id)=>chat.stop(str(id)));
  handle('chat.retry',(id)=>chat.retry(str(id)));
  handle('chat.approve',(id,allow)=>{if(typeof allow!=='boolean')throw new Error('Invalid approval.');return chat.approve(str(id),allow);});
  handle('chat.extensionUi',(id)=>chat.extensionUiState(str(id)));
  handle('chat.commands',(id)=>chat.pluginCommands(str(id)));
  handle('chat.compact', id => chat.compact(str(id)));
  handle('chat.answerExtension',(id,dialogId,value)=>{
    const answer=record(value);
    // Exactly one of the three shapes Pi takes back.
    const shaped=answer.cancelled===true?{cancelled:true as const}:typeof answer.confirmed==='boolean'?{confirmed:answer.confirmed}:typeof answer.value==='string'&&answer.value.length<=100_000?{value:answer.value}:null;
    if(!shaped)throw new Error('Invalid answer.');
    return chat.answerExtension(str(id),str(dialogId,'question',200),shaped);
  });
  handle('notebooks.list',(id,type)=>store.listNotebooks(str(id),kind(type)));
  handle('notebooks.save',(value)=>{const input=record(value);if(typeof input.body!=='string'||typeof input.title!=='string')throw new Error('Notebook title and body must be text.');
    if(input.expectedUpdatedAt!==undefined&&(!Number.isSafeInteger(input.expectedUpdatedAt)||Number(input.expectedUpdatedAt)<0))throw new Error('Invalid notebook version.');
    return store.saveNotebook({...(input.id?{id:str(input.id)}:{}),conversationId:str(input.conversationId),kind:kind(input.kind),title:input.title,body:input.body,...(input.expectedUpdatedAt===undefined?{}:{expectedUpdatedAt:Number(input.expectedUpdatedAt)})});});
  handle('notebooks.delete',(id)=>store.deleteNotebook(str(id)));
  handle('notebooks.share',(id,shared)=>{if(typeof shared!=='boolean')throw new Error('Invalid notebook switch.');return store.shareNotebook(str(id),shared);});
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
  // Pi's own agent folder: PI_CODING_AGENT_DIR moves it, unless a test home is set.
  const piAgentHome=():[string,string?]=>process.env.HELLO_HOME_DIR||!process.env.PI_CODING_AGENT_DIR?[discoveryHome()]:[discoveryHome(),process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/,homedir())];
  // The folders this app's own chats are attached to are projects too.
  const discoveryProjects=()=>store.listConversations().map(item=>item.folder).filter((folder): folder is string=>Boolean(folder));
  handle('extensions.discover',async()=>{
    const [mcp,skills,plugins]=await Promise.all([discoverMcpServers(discoveryHome(),discoveryProjects()),discoverSkills(discoveryHome(),discoveryProjects(),dshSkillRoots(store.dataDir)),discoverPiExtensions(...piAgentHome())]);
    return {mcp:withoutSecrets(mcp),skills,plugins};
  });
  handle('extensions.importDiscovered',async(kind,id)=>{
    const wanted=str(kind,'kind',20);const wantedId=str(id,'id',8192);
    if(wanted==='skill'){
      const skill=(await discoverSkills(discoveryHome(),discoveryProjects(),dshSkillRoots(store.dataDir))).find(item=>item.id===wantedId);
      if(!skill)throw new Error('That skill is no longer where it was found.');
      const imported=await chat.library.importPath('skill',skill.path);
      announceExtensions();
      return imported;
    }
    if(wanted==='plugin'){
      // Imported like a chosen folder: copied, and bundled with its npm packages when it imports any.
      const plugin=(await discoverPiExtensions(...piAgentHome())).find(item=>item.id===wantedId);
      if(!plugin)throw new Error('That Pi extension is no longer where it was found.');
      const imported=await chat.library.importPath('plugin',plugin.path);
      announceExtensions();
      return imported;
    }
    if(wanted!=='mcp')throw new Error('Only skills, Pi extensions and MCP servers are discovered.');
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
  // Files the person picks to attach (S209): files only, never a folder, over this window.
  handle('system.chooseFiles',async()=>{const result=await dialog.showOpenDialog(window,{title:'Attach files',properties:['openFile','multiSelections']});return result.canceled?null:result.filePaths;});
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
  // A chat waiting for the person while they are elsewhere: a native
  // notification that brings that chat forward, and the count on the Dock.
  const notices=new Set<Notification>();
  handle('system.notify',(value)=>{
    const input=record(value);
    const title=str(input.title,'title',200),body=str(input.body,'body',500),conversationId=str(input.conversationId);
    store.getConversation(conversationId);
    if(typeof Notification!=='function'||!Notification.isSupported())return false;
    const notice=new Notification({title,body});
    notices.add(notice);
    const done=()=>notices.delete(notice);
    notice.on('click',()=>{
      done();
      if(window.isDestroyed())return;
      if(window.isMinimized())window.restore();
      window.show();window.focus();
      window.webContents.send('hello:focus-conversation',conversationId);
    });
    notice.on('close',done);
    notice.show();
    return true;
  });
  handle('system.badge',(value)=>{
    const count=typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<1000?value:0;
    app.setBadgeCount?.(count);
  });
  handle('system.revealPath',(input)=>{
    const target=resolve(str(input,'path',8192));
    const allowed=[store.dataDir,...store.listConversations().flatMap(c=>c.folder?[c.folder]:[])];
    if(!allowed.some(folder=>target===folder||target.startsWith(folder+sep)))throw new Error('This path is outside the workspace.');
    shell.showItemInFolder(target);
  });
  handle('terminal.list',()=>terminal.list());
  handle('terminal.workers',()=>terminal.workers());
  handle('terminal.create',(id,worker,session)=>{
    // A chat tab's CLI coming back after a restart continues its own conversation.
    if(session!==undefined&&(typeof session!=='string'||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(session)))throw new Error('Invalid CLI session.');
    return terminal.create(str(id),worker===undefined||worker===null?undefined:str(worker,'worker') as WorkerId,session as string|undefined);
  });
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
  // The chat's downloads. Paths come from main's own list, never from the window.
  handle('browser.downloads.list',(id)=>browser.downloadsOf(str(id)));
  handle('browser.downloads.open',async(id)=>{const failure=await shell.openPath(browser.downloadPath(str(id)));if(failure)throw new Error(failure);});
  handle('browser.downloads.reveal',(id)=>shell.showItemInFolder(browser.downloadPath(str(id))));
  handle('browser.downloads.cancel',(id)=>browser.cancelDownload(str(id)));
  handle('browser.downloads.remove',(id)=>browser.removeDownload(str(id)));
  handle('browser.downloads.clear',(id)=>browser.clearDownloads(str(id)));
  handle('browser.downloads.folder',(id)=>browser.downloadFolder(str(id)));
  // Design / Annotate: the human's own gestures on a page. Grants are checked
  // in the controller against the tab as main holds it, never as sent here.
  if(pageModes){
    const modeKind=(value:unknown)=>{if(value!=='design'&&value!=='annotate')throw new Error('Unknown page mode.');return value;};
    const optionalId=(value:unknown)=>value===undefined||value===null?undefined:str(value,'mode',100);
    handle('browser.mode.arm',(id,value)=>pageModes.arm(str(id),modeKind(value)));
    handle('browser.mode.disarm',(id,armId)=>pageModes.disarm(str(id),optionalId(armId)));
    handle('browser.mode.release',(id,armId)=>pageModes.release(str(id),str(armId,'mode',100)));
    handle('browser.mode.capture',(id,rect)=>{
      if(rect!==undefined&&rect!==null){
        const box=record(rect);
        if(Object.keys(box).some(key=>!['x','y','w','h'].includes(key))||['x','y','w','h'].some(key=>typeof box[key]!=='number'||!Number.isFinite(box[key])))throw new Error('Invalid capture area.');
        return pageModes.capture(str(id),box as unknown as PageRect);
      }
      return pageModes.capture(str(id));
    });
    handle('browser.mode.copy',(text,path)=>{
      if(typeof text!=='string')throw new Error('Clipboard content must be text.');
      return pageModes.copy(text,path===undefined||path===null?undefined:str(path,'path',8192));
    });
  }
  return()=>{for(const channel of registered)ipcMain.removeHandler(channel);};
}
