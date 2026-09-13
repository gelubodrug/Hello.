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
      messages: async () => [], export: unsupported,
    },
    settings: {get:async()=>settings,save:async(patch)=>{const {apiKey,...safe}=patch; settings={...settings,...safe,apiKeySet:false};write('settings',settings);return settings;},models:unsupported,rememberConnection:unsupported,useConnection:unsupported,forgetConnection:unsupported},
    chat:{attach:unsupported,send:unsupported,queue:unsupported,queued:async()=>[],reviseQueued:unsupported,dropQueued:unsupported,stop:async()=>{},retry:unsupported,approve:unsupported,onEvent:()=>()=>{}},
    // The design preview has no library: importing runs in the desktop app.
    extensions:{list:async()=>[],importResource:unsupported,examples:async()=>[],importExample:unsupported,addMcp:unsupported,discover:async()=>({mcp:[],skills:[]}),importDiscovered:unsupported,update:unsupported,remove:unsupported,active:async()=>[],setActive:unsupported,status:async()=>[],probe:unsupported,disconnect:unsupported,onChange:()=>()=>{}},
    notebooks:{
      list:async(id,kind)=>entries.filter(entry=>entry.conversationId===id&&entry.kind===kind),
      save:async(input)=>{
        const existing=entries.find(entry=>entry.id===input.id);
        if(input.id&&!existing)throw new Error('Notebook entry not found.');
        if(existing&&(existing.conversationId!==input.conversationId||existing.kind!==input.kind))throw new Error('Notebook entry belongs to another notebook.');
        if(input.expectedUpdatedAt!==undefined&&existing?.updatedAt!==input.expectedUpdatedAt)throw new Error('Notebook changed since this draft was opened.');
        const {expectedUpdatedAt: _version,...content}=input;
        const entry={...content,id:input.id||crypto.randomUUID(),createdAt:existing?.createdAt||Date.now(),updatedAt:Math.max(Date.now(),(existing?.updatedAt??0)+1)};
        entries=[...entries.filter(item=>item.id!==entry.id),entry];write('entries',entries);
        emitNotebook({conversationId:entry.conversationId,kind:entry.kind});return entry;
      },
      delete:async(id)=>{const entry=entries.find(item=>item.id===id);entries=entries.filter(entry=>entry.id!==id);write('entries',entries);if(entry)emitNotebook({conversationId:entry.conversationId,kind:entry.kind});},
      paths:unsupported,
      onChange:listener=>{notebookListeners.add(listener);return()=>notebookListeners.delete(listener);},
    },
    system:{chooseFolder:unsupported,pathsForFiles:()=>{throw new Error('File drops need the Hello. desktop app.');},openExternal:async(url)=>{window.open(url,'_blank','noopener,noreferrer');},revealPath:unsupported,copy:async({text,html})=>{
      if(html!==undefined){
        if(typeof ClipboardItem==='undefined'||!navigator.clipboard?.write)throw new Error('Formatted copying is unavailable in this browser. Use Copy Markdown or open the desktop app.');
        await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'}),'text/html':new Blob([html],{type:'text/html'})})]);
      }else await navigator.clipboard.writeText(text);
    }},
    terminal:{list:async()=>[],workers:async()=>[],create:unsupported,attach:unsupported,write:unsupported,resize:async()=>{},close:async()=>{},onData:()=>()=>{},onExit:()=>()=>{}},
    browser:{create:unsupported,navigate:unsupported,action:unsupported,setActive:async()=>{},attach:unsupported,detach:async()=>{},control:unsupported,read:unsupported,close:async()=>{},onUpdate:()=>()=>{}},
  };
}

const bridge = desktop ? window.hello : previewAPI();

export function onNativeBrowserFocus(listener: () => void): () => void {
  return bridge.browser.onFocus?.(listener) ?? (() => {});
}
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
  }, send: async (id,text,attachmentIds) => {
    if(attachmentIds?.length&&typeof bridge.chat.attach!=='function')throw new Error('Attachments need the updated Hello. main process and preload. Reopen Hello. when ready.');
    await bridge.chat.send(id,text,attachmentIds);
  }},
  system: {...bridge.system, pathsForFiles: files => {
    if(typeof bridge.system.pathsForFiles!=='function')throw new Error('File drops need the updated Hello. preload. Reopen Hello. when ready.');
    return bridge.system.pathsForFiles(files);
  }, copy: async content => {
    if(typeof bridge.system.copy!=='function')throw new Error('Restart Hello. to finish updating clipboard support.');
    await bridge.system.copy(content);
  }},
};
