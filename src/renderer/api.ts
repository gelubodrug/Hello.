import type { Bootstrap, HelloAPI, Conversation, AppSettings, NotebookEntry, NotebookChange, BrowserTab } from '../shared/types';

const desktop = typeof window.hello !== 'undefined';
export const isDesktop = desktop;

function previewAPI(): HelloAPI {
  const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(`hello-preview:${key}`) || 'null') ?? fallback; } catch { return fallback; } };
  const write = (key: string,value: unknown) => localStorage.setItem(`hello-preview:${key}`,JSON.stringify(value));
  let conversations = read<Conversation[]>('chats',[]);
  let entries = read<NotebookEntry[]>('entries',[]);
  const notebookListeners = new Set<(event: NotebookChange) => void>();
  const emitNotebook = (event: NotebookChange) => { for (const listener of notebookListeners) listener(event); };
  const settingsDefaults: AppSettings = {endpointUrl:'http://127.0.0.1:11434/v1',model:'',apiKeySet:false,temperature:0.7,systemPrompt:'',reasoningEffort:'off',connections:[]};
  // Merge: a settings object stored by an older preview lacks newer fields.
  let settings: AppSettings = {...settingsDefaults,...read<Partial<AppSettings>>('settings',{}),connections:read<Partial<AppSettings>>('settings',{}).connections ?? []};
  const browserTabs: BrowserTab[] = [];
  const unsupported = async (): Promise<never> => { throw new Error('This is the design preview. Open the Hello. desktop app to use live models, browser and terminals.'); };
  const persistChats = () => write('chats', conversations);
  const seed: Bootstrap = {conversations,settings,workers:[],terminals:[],browsers:browserTabs,dataPath:'Design preview — page-local data only',version:'0.1.0',extensionsCount:0};
  return {
    files: { list: unsupported, read: unsupported, open: unsupported, reveal: unsupported, resolvePaths: unsupported },
    bootstrap: async () => ({...seed,conversations,settings}),
    conversations: {
      list: async () => conversations,
      create: async (title='New chat') => { const chat = {id:crypto.randomUUID(),title,folder:null,createdAt:Date.now(),updatedAt:Date.now()}; conversations=[chat,...conversations]; persistChats(); return chat; },
      update: async (id,patch) => { const chat=conversations.find(item=>item.id===id); if(!chat) throw new Error('Chat not found.'); Object.assign(chat,patch,{updatedAt:Date.now()}); persistChats(); return {...chat}; },
      delete: async (id) => {conversations=conversations.filter(chat=>chat.id!==id);persistChats();},
      restart: async (id) => { const chat=conversations.find(item=>item.id===id); if(!chat) throw new Error('Chat not found.'); chat.freshFrom=Date.now(); persistChats(); return {...chat}; },
      reset: async (id, options) => { const chat=conversations.find(item=>item.id===id); if(!chat) throw new Error('Chat not found.'); delete chat.freshFrom; if(options?.notes!==false){entries=entries.filter(entry=>entry.conversationId!==id);write('entries',entries);emitNotebook({conversationId:id,kind:'runbook'});emitNotebook({conversationId:id,kind:'tasks'});emitNotebook({conversationId:id,kind:'plan'});} persistChats(); return {...chat}; },
      messages: async () => [], export: unsupported,
    },
    settings: {get:async()=>settings,save:async(patch)=>{const {apiKey,...safe}=patch; settings={...settings,...safe,apiKeySet:false};write('settings',settings);return settings;},models:unsupported,catalog:unsupported,localServers:async()=>[],voiceServers:async()=>[],rememberConnection:unsupported,useConnection:unsupported,forgetConnection:unsupported},
    chat:{attach:unsupported,previewAttachment:unsupported,send:unsupported,queue:unsupported,queued:async()=>[],reviseQueued:unsupported,dropQueued:unsupported,stop:async()=>{},retry:unsupported,approve:unsupported,onEvent:()=>()=>{}},
    // The design preview has no library: importing runs in the desktop app.
    extensions:{list:async()=>[],importResource:unsupported,examples:async()=>[],importExample:unsupported,addMcp:unsupported,discover:async()=>({mcp:[],skills:[]}),importDiscovered:unsupported,update:unsupported,remove:unsupported,active:async()=>[],setActive:unsupported,status:async()=>[],probe:unsupported,disconnect:unsupported,onChange:()=>()=>{}},
    skills:{list:async()=>[],search:async()=>({local:[],online:[]}),use:unsupported},
    notebooks:{
      list:async(id,kind)=>entries.filter(entry=>entry.conversationId===id&&entry.kind===kind),
      save:async(input)=>{
        const existing=entries.find(entry=>entry.id===input.id);
        if(input.id&&!existing)throw new Error('Notebook entry not found.');
        if(existing&&(existing.conversationId!==input.conversationId||existing.kind!==input.kind))throw new Error('Notebook entry belongs to another notebook.');
        if(input.expectedUpdatedAt!==undefined&&existing?.updatedAt!==input.expectedUpdatedAt)throw new Error('Notebook changed since this draft was opened.');
        const {expectedUpdatedAt: _version,...content}=input;
        const entry={...content,id:input.id||crypto.randomUUID(),createdAt:existing?.createdAt||Date.now(),updatedAt:Math.max(Date.now(),(existing?.updatedAt??0)+1),shared:existing?.shared??true};
        entries=[...entries.filter(item=>item.id!==entry.id),entry];write('entries',entries);
        emitNotebook({conversationId:entry.conversationId,kind:entry.kind});return entry;
      },
      delete:async(id)=>{const entry=entries.find(item=>item.id===id);entries=entries.filter(entry=>entry.id!==id);write('entries',entries);if(entry)emitNotebook({conversationId:entry.conversationId,kind:entry.kind});},
      share:async(id,shared)=>{const entry=entries.find(item=>item.id===id);if(!entry)throw new Error('Notebook entry not found.');const next={...entry,shared};entries=entries.map(item=>item.id===id?next:item);write('entries',entries);emitNotebook({conversationId:entry.conversationId,kind:entry.kind});return next;},
      paths:unsupported,
      onChange:listener=>{notebookListeners.add(listener);return()=>notebookListeners.delete(listener);},
    },
    system:{chooseFolder:unsupported,pathsForFiles:()=>{throw new Error('File drops need the Hello. desktop app.');},openExternal:async(url)=>{window.open(url,'_blank','noopener,noreferrer');},revealPath:unsupported,copy:async({text,html})=>{
      if(html!==undefined){
        if(typeof ClipboardItem==='undefined'||!navigator.clipboard?.write)throw new Error('Formatted copying is unavailable in this browser. Use Copy Markdown or open the desktop app.');
        await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'}),'text/html':new Blob([html],{type:'text/html'})})]);
      }else await navigator.clipboard.writeText(text);
    }},
    terminal:{list:async()=>[],workers:async()=>[],create:unsupported,attach:unsupported,write:unsupported,resize:async()=>{},close:async()=>{},onCreated:()=>()=>{},onData:()=>()=>{},onExit:()=>()=>{}},
    browser:{create:unsupported,navigate:unsupported,action:unsupported,setActive:async()=>{},attach:unsupported,detach:async()=>{},control:unsupported,read:unsupported,close:async()=>{},onUpdate:()=>()=>{},downloads:{list:async()=>[],open:unsupported,reveal:unsupported,cancel:unsupported,remove:unsupported,clear:unsupported,folder:unsupported,onChange:()=>()=>{}},mode:{arm:unsupported,disarm:async()=>{},release:async()=>{},capture:unsupported,copy:unsupported,onEvent:()=>()=>{}}},
    // The design preview shows the market and the DSH surface with sample
    // data — the 1024Store's top three as of 28.09.2026 — and fetches nothing.
    // The Pi row with an update on offer, as the sidebar shows it; updating needs the desktop app.
    piEngine:{status:async()=>({version:'0.99.1',bundled:'0.99.1',latest:'0.99.2',state:'idle'}),update:unsupported,useBundled:unsupported,onStatus:()=>()=>{}},
    dsh:{status:async()=>({state:'absent',version:'0.1.7-rc.2',profileDir:'(desktop app only)',logFile:'',checkpoints:[]}),install:unsupported,start:unsupported,stop:unsupported,restart:unsupported,restore:unsupported,attach:unsupported,detach:async()=>{},reload:async()=>{},revealLogs:unsupported,onStatus:()=>()=>{},onOpenLink:()=>()=>{}},
    market:{
      sources:async()=>[
        {id:'dsh-1024store',name:'DSH 1024Store',description:'Partner provider catalog. The user must add and enable it explicitly. Being listed does not mean a plugin was reviewed or recommended.',homepage:'https://deepseek1024.com',endpointHost:'deepseek1024.com',builtIn:true,partner:true,selected:true,available:true,added:true,attribution:{name:'DSH 1024Store',url:'https://deepseek1024.com',notice:'Community catalog data provided by a cooperating provider.'}},
        {id:'dshfind',name:'dshfind',description:'Partner provider catalog. The user must add and enable it explicitly. Being listed does not mean a plugin was reviewed or recommended.',homepage:'https://dshfind.com',endpointHost:'api.dshfind.com',builtIn:true,partner:true,selected:false,available:true,added:false,attribution:{name:'dshfind',url:'https://dshfind.com',notice:'Community catalog data provided by a cooperating provider.'}},
      ],
      addSource:unsupported,addStandardSource:unsupported,removeSource:unsupported,selectSource:unsupported,
      query:async(query)=>{
        const items=[
          {key:'p:1',name:'dsh1024',summary:'The DSH 1024Store client plugin: browse and search the live deepseek1024.com catalog from Settings, filter by category, confirmed one-click installs and uninstalls, plus self-update checks.',publisher:'imsai-sh',categories:['tools'],repository:'https://github.com/imsai-sh/awesome-deepseek-harness-plugins',installable:false,manualCommand:'dsh plugin --profile web add github:imsai-sh/awesome-deepseek-harness-plugins',sourceName:'DSH 1024Store',installs:793,stars:251},
          {key:'p:2',name:'dsh-memory-plugin',summary:'Unifies long-term memory, knowledge retrieval, and skills into a self-evolving context database for agents.',publisher:'volcengine',categories:['memory'],repository:'https://github.com/volcengine/OpenViking',installable:true,sourceName:'DSH 1024Store',installs:386,stars:38859},
          {key:'p:3',name:'deepseek-harness',summary:'Generates self-contained, motion-rich diagrams for architecture, workflow, and data-flow with crisp export, packaged as an agent skill.',publisher:'tt-a1i',categories:['skill'],repository:'https://github.com/tt-a1i/archify',installable:true,sourceName:'DSH 1024Store',installs:245,stars:72621},
        ].filter(item=>(!query.installable||item.installable)&&(!query.category||item.categories.includes(query.category))&&(!query.q||item.name.includes(query.q)||item.summary.toLowerCase().includes(query.q.toLowerCase())));
        return {items,total:items.length,categories:['tools','ui','dev','skill','session','model','workflow','fun','notify','theme','memory']};
      },
      icon:async()=>null,installed:async()=>[],preview:unsupported,previewByName:unsupported,previewUninstall:unsupported,previewFolder:unsupported,confirm:unsupported,
    },
    // The Pi market with three packages from npm's list as of 29.09.2026; nothing is fetched.
    piMarket:{
      sources:async()=>[{id:'pi-gallery',name:'Pi packages',description:'pi.dev/packages, the official gallery of every npm package marked “pi-package”. Being listed does not mean a package was reviewed or recommended.',homepage:'https://pi.dev/packages',endpointHost:'pi.dev',builtIn:true,partner:false,selected:true,available:true,added:true,attribution:{name:'pi.dev/packages',url:'https://pi.dev/packages',notice:'Listing from the official Pi gallery; npm’s search stands in when it does not answer. Packages install from the npm registry.'}}],
      query:async(query)=>{
        const items=[
          {key:'pi:1',name:'pi-mcp-adapter',summary:'Use MCP servers from Pi: tools from any Model Context Protocol server, on demand.',publisher:'nicopreme',categories:['extension'],repository:'https://github.com/nicobailon/pi-mcp-adapter',installable:true,sourceName:'Pi packages',installs:1151974,stars:0,updatedAt:'2026-09-28T17:00:00.000Z'},
          {key:'pi:2',name:'pi-subagents',summary:'Pi extension for single-agent delegation and scripted multi-agent workflows',publisher:'nicopreme',categories:['package'],repository:'https://github.com/nicobailon/pi-subagents',installable:true,sourceName:'Pi packages',installs:488728,stars:0,updatedAt:'2026-09-27T19:08:09.350Z'},
          {key:'pi:3',name:'@juicesharp/rpiv-todo',summary:'A todo list the model keeps, shown beside the conversation.',publisher:'juicesharp',categories:['extension'],repository:'https://github.com/juicesharp/rpiv-mono',installable:true,sourceName:'Pi packages',installs:40211,stars:0,updatedAt:'2026-09-20T08:00:00.000Z'},
        ].filter(item=>(!query.category||item.categories.includes(query.category))&&(!query.q||item.name.includes(query.q)||item.summary.toLowerCase().includes(query.q.toLowerCase())));
        return {items,total:items.length,unfiltered:5548,categories:['extension','skill','theme','prompt']};
      },
      icon:async()=>null,installed:async()=>[],preview:unsupported,previewByName:unsupported,previewUninstall:unsupported,previewUpdate:unsupported,confirm:unsupported,
    },
  };
}

const bridge = desktop ? window.hello : previewAPI();

export function onNativeBrowserFocus(listener: () => void): () => void {
  return bridge.browser.onFocus?.(listener) ?? (() => {});
}
const stale = async (): Promise<never> => { throw new Error('Downloads need the updated Hello. main process and preload. Reopen Hello. when ready.'); };
export const api: HelloAPI = {
  ...bridge,
  files: {...(bridge.files ?? {
    list: async () => { throw new Error('Files needs the updated Electron main process and preload. Reload your dev session when ready.'); },
    read: async () => { throw new Error('Files needs the updated Electron main process and preload. Reload your dev session when ready.'); },
    open: async () => { throw new Error('Files needs the updated Electron main process and preload.'); },
    reveal: async () => { throw new Error('Files needs the updated Electron main process and preload.'); },
  }), resolvePaths: async (id,paths) => {
    if(typeof bridge.files?.resolvePaths!=='function')throw new Error('File drops need the updated Hello. main process and preload. Reopen Hello. when ready.');
    return bridge.files.resolvePaths(id,paths);
  }},
  chat: {...bridge.chat, attach: async (id,paths) => {
    if(typeof bridge.chat.attach!=='function')throw new Error('Attachments need the updated Hello. main process and preload. Reopen Hello. when ready.');
    return bridge.chat.attach(id,paths);
  }, previewAttachment: async (id,attachmentId) => {
    if(typeof bridge.chat.previewAttachment!=='function')throw new Error('Attachment previews need the updated Hello. main process and preload. Reopen Hello. when ready.');
    return bridge.chat.previewAttachment(id,attachmentId);
  }, send: async (id,text,attachmentIds) => {
    if(attachmentIds?.length&&typeof bridge.chat.attach!=='function')throw new Error('Attachments need the updated Hello. main process and preload. Reopen Hello. when ready.');
    await bridge.chat.send(id,text,attachmentIds);
  }},
  browser: {...bridge.browser, downloads: bridge.browser.downloads ?? {
    list: async () => [], onChange: () => () => {},
    open: stale, reveal: stale, cancel: stale, remove: stale, clear: stale, folder: stale,
  }},
  system: {...bridge.system, pathsForFiles: files => {
    if(typeof bridge.system.pathsForFiles!=='function')throw new Error('File drops need the updated Hello. preload. Reopen Hello. when ready.');
    return bridge.system.pathsForFiles(files);
  }, copy: async content => {
    if(typeof bridge.system.copy!=='function')throw new Error('Restart Hello. to finish updating clipboard support.');
    await bridge.system.copy(content);
  }},
};
