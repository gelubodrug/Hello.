import { describe,it,expect } from 'vitest';
import {browserURL,checkAgentAccess,checkAgentOwnership,safeBounds,searchInstead} from '../src/main/browser/policy';
import type { BrowserTab } from '../src/shared/types';
const tab:BrowserTab={id:'one',conversationId:'chat',title:'Page',url:'https://example.com',control:'off',loading:false,progress:null,canGoBack:false,canGoForward:false};
describe('browser safety boundary',()=>{
  it('normalizes addresses and search without executable schemes',()=>{
    expect(browserURL('example.com')).toBe('https://example.com/');
    expect(browserURL('hello workspace')).toContain('search?q=hello%20workspace');
    expect(browserURL('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/');
    for(const url of ['javascript:alert(1)','file:///etc/passwd','data:text/html,hello','https://user:secret@example.com'])expect(()=>browserURL(url)).toThrow();
  });
  it('searches for a bare name no site answers to, never for a machine of the person\'s own',()=>{
    expect(searchInstead(' smarbill.ro ')).toBe('https://www.google.com/search?q=smarbill.ro');
    expect(searchInstead('smarbill.ro/facturi')).toBe('https://www.google.com/search?q=smarbill.ro%2Ffacturi');
    for(const input of ['https://smarbill.ro','hello workspace','localhost','app.localhost','printer.local','nas.lan','db.internal','site.test','router.home.arpa','shop.example.com:8080','192.168.1.10','10.0.0.1/admin'])expect(searchInstead(input)).toBeNull();
  });
  it('gates reads and actions per chat, not a global mode',()=>{
    expect(()=>checkAgentAccess(tab,'chat')).toThrow('Off');
    expect(()=>checkAgentAccess({...tab,control:'read'},'chat')).not.toThrow();
    expect(()=>checkAgentAccess({...tab,control:'read'},'chat',true)).toThrow('read only');
    expect(()=>checkAgentAccess({...tab,control:'full'},'other',true)).toThrow('different chat');
    expect(()=>checkAgentAccess({...tab,control:'full'},'chat',true)).not.toThrow();
  });
  it.each(['off','read','full'] as const)('checks ownership independently of %s page access',control=>{
    const owned={...tab,control};
    expect(()=>checkAgentOwnership(owned,'chat')).not.toThrow();
    expect(()=>checkAgentOwnership(owned,'other')).toThrow('different chat');
    expect(owned.control).toBe(control);
  });
  it('bounds native content away from header and inside the window',()=>{
    expect(safeBounds({x:-10,y:0,width:1500,height:2000},1000,800)).toEqual({x:0,y:48,width:1000,height:752});
    expect(()=>safeBounds({x:NaN,y:0,width:100,height:100},1000,800)).toThrow();
  });
});
