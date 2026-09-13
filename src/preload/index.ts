import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { HelloAPI } from '../shared/types';

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`hello:${method}`,...args);
function subscribe<T>(channel: string, listener: (value:T)=>void): ()=>void {
  const handler = (_event: Electron.IpcRendererEvent, value:T) => listener(value);
  ipcRenderer.on(channel,handler);
  return()=>ipcRenderer.removeListener(channel,handler);
}
const api: HelloAPI = {
  files:{list:(id,path,search)=>call('files.list',id,path,search),read:(id,path)=>call('files.read',id,path),open:(id,path)=>call('files.open',id,path),reveal:(id,path)=>call('files.reveal',id,path),resolvePaths:(id,paths)=>call('files.resolvePaths',id,paths)},
  bootstrap:()=>call('bootstrap'),
  conversations:{list:()=>call('conversations.list'),create:title=>call('conversations.create',title),update:(id,patch)=>call('conversations.update',id,patch),delete:id=>call('conversations.delete',id),messages:id=>call('conversations.messages',id),export:id=>call('conversations.export',id)},
  settings:{get:()=>call('settings.get'),save:patch=>call('settings.save',patch),models:()=>call('settings.models'),rememberConnection:name=>call('settings.rememberConnection',name),useConnection:url=>call('settings.useConnection',url),forgetConnection:url=>call('settings.forgetConnection',url)},
  chat:{attach:(id,paths)=>call('chat.attach',id,paths),send:(id,text,attachments)=>call('chat.send',id,text,attachments),queue:(id,text,mode)=>call('chat.queue',id,text,mode),queued:id=>call('chat.queued',id),reviseQueued:(id,patch)=>call('chat.reviseQueued',id,patch),dropQueued:id=>call('chat.dropQueued',id),stop:id=>call('chat.stop',id),retry:id=>call('chat.retry',id),approve:(id,allow)=>call('chat.approve',id,allow),onEvent:listener=>subscribe('hello:chat-event',listener)},
  notebooks:{list:(id,kind)=>call('notebooks.list',id,kind),save:input=>call('notebooks.save',input),delete:id=>call('notebooks.delete',id),paths:id=>call('notebooks.paths',id),onChange:listener=>subscribe('hello:notebooks-changed',listener)},
  extensions:{list:()=>call('extensions.list'),importResource:kind=>call('extensions.importResource',kind),examples:()=>call('extensions.examples'),importExample:(kind,name)=>call('extensions.importExample',kind,name),addMcp:input=>call('extensions.addMcp',input),discover:()=>call('extensions.discover'),importDiscovered:(kind,id)=>call('extensions.importDiscovered',kind,id),update:id=>call('extensions.update',id),remove:id=>call('extensions.remove',id),active:id=>call('extensions.active',id),setActive:(id,resourceId,active)=>call('extensions.setActive',id,resourceId,active),status:()=>call('extensions.status'),probe:id=>call('extensions.probe',id),disconnect:id=>call('extensions.disconnect',id),onChange:listener=>subscribe('hello:extensions-changed',listener)},
  system:{chooseFolder:()=>call('system.chooseFolder'),pathsForFiles:files=>{
    if(!Array.isArray(files)||!files.length||files.length>16)throw new Error('Drop between 1 and 16 files or folders.');
    return files.map(file=>{
      const path=webUtils.getPathForFile(file);
      if(!path)throw new Error('This item has no local file. Save it to your computer, then drag it into Hello.');
      if(path.length>8192||/[\u0000-\u001f\u007f-\u009f]/.test(path))throw new Error('Rename this file to remove control characters before dropping it.');
      return path;
    });
  },openExternal:url=>call('system.openExternal',url),revealPath:path=>call('system.revealPath',path),copy:content=>call('system.copy',content)},
  terminal:{list:()=>call('terminal.list'),workers:()=>call('terminal.workers'),create:(id,worker)=>call('terminal.create',id,worker),attach:id=>call('terminal.attach',id),write:(id,data)=>call('terminal.write',id,data),resize:(id,cols,rows)=>call('terminal.resize',id,cols,rows),close:id=>call('terminal.close',id),onData:listener=>subscribe('hello:terminal-data',listener),onExit:listener=>subscribe('hello:terminal-exit',listener)},
  browser:{create:(id,url)=>call('browser.create',id,url),navigate:(id,url)=>call('browser.navigate',id,url),action:(id,action)=>call('browser.action',id,action),setActive:id=>call('browser.setActive',id),attach:id=>call('browser.attach',id),detach:(id,nonce)=>call('browser.detach',id,nonce),control:(id,mode)=>call('browser.control',id,mode),read:id=>call('browser.read',id),close:id=>call('browser.close',id),onUpdate:listener=>subscribe('hello:browser-update',listener),onFocus:listener=>subscribe('hello:browser-focus',listener),onLifecycle:listener=>subscribe('hello:browser-lifecycle',listener),
    mode:{arm:(id,kind)=>call('browser.mode.arm',id,kind),disarm:(id,armId)=>call('browser.mode.disarm',id,armId),release:(id,armId)=>call('browser.mode.release',id,armId),capture:(id,rect)=>call('browser.mode.capture',id,rect),copy:(text,path)=>call('browser.mode.copy',text,path),onEvent:listener=>subscribe('hello:browser-mode',listener)}},
};
contextBridge.exposeInMainWorld('hello',Object.freeze(api));
