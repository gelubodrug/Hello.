import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Loader2, MessageSquarePlus, RotateCw, X } from 'lucide-react';
import type { AgentControl, BrowserTab, ChatQuoteExtra } from '../../shared/types';
import { api } from '../api';
import { MenuButton } from '../ui/primitives';
import './browser.css';
import { PageModeSwitch } from './PageModeSwitch';
import { usePageMode } from './usePageMode';
import { DesignComposer } from './design/DesignComposer';
import { AnnotateBar } from './annotate/AnnotateBar';
import { DownloadsMenu } from './DownloadsMenu';

interface Props { tab: BrowserTab; visible: boolean; onTabChange(tab: BrowserTab): void; onQuote(text: string, extra?: ChatQuoteExtra): void; }
const modes: {value:AgentControl;label:string;detail:string}[] = [
  {value:'off',label:'Off',detail:'Open pages on request; no page reading or interaction'},
  {value:'read',label:'Read only',detail:'Open and read pages; no clicking or typing'},
  {value:'full',label:'Full access',detail:'Open, read and interact with pages'},
];
// One publisher for this app window, including its parked conversations. Each
// visible pane owns only its registration; hiding it cannot clear another's.
const visiblePanes = new Map<symbol, string>();
let activePublicationPending = false;
function publishVisibleBrowser(): void {
  if (activePublicationPending) return;
  activePublicationPending = true;
  // React runs every old effect's cleanup before the new effects. Publish after
  // both, so a tab switch sends its final selection without an intermediate null.
  queueMicrotask(() => {
    activePublicationPending = false;
    const id = [...visiblePanes.values()].at(-1) ?? null;
    void api.browser.setActive(id).catch(() => {});
  });
}
function AIModeGlyph(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 4.7a7.5 7.5 0 1 0 4.3 8.8M15.5 15.5 21 21"/>
    <path d="m17 3 1.2 3.8L22 8l-3.8 1.2L17 13l-1.2-3.8L12 8l3.8-1.2Z" fill="currentColor" stroke="none"/>
  </svg>;
}
export function BrowserPane({tab,visible,onTabChange,onQuote}: Props): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [address,setAddress] = useState(tab.url==='about:blank'?'':tab.url);
  const [error,setError] = useState('');
  const [quoting,setQuoting] = useState(false);
  const isStartPage = tab.url==='about:blank'&&!tab.pageOwned;
  useEffect(()=>setAddress(tab.url==='about:blank'?'':tab.url),[tab.url]);
  useEffect(()=>api.browser.onUpdate(next=>{if(next.id===tab.id)onTabChange(next);}),[tab.id,onTabChange]);
  // The page is a document element, so menus stack above it by CSS alone. It
  // lives in its own fixed host rather than inside the pane, because Chromium
  // never creates the page while its element sits under display:none — and a
  // chat's tabs must stay readable with their pane closed. The host is only
  // moved and hidden, never unmounted, so the page survives.
  const place = useRef<() => void>(() => {});
  const size = useRef({ width: 1024, height: 720 });
  useLayoutEffect(()=>{
    const host=document.createElement('div');
    host.className='browser-guest-host';
    (document.getElementById('root')??document.body).appendChild(host);
    let element:HTMLElement|null=null;
    let dropped=false;
    let mounted='';
    let frame=0;
    // Full screen, the page covers the window — the stylesheet holds it there — and is not moved.
    let full=false;
    const apply=()=>{
        if(full)return;
        const slot=viewport.current;
        if(!slot)return;
        const rect=slot.getBoundingClientRect();
        // A start page or a failed load shows app chrome in the pane, so the
        // page is parked behind it — but it still exists, because navigating
        // from that start page is what asks it to load something.
        const shown=shownRef.current&&pageRef.current&&rect.width>2&&rect.height>2;
        // A page that is not on screen is parked off it, at a real size and
        // still rendered: Chromium creates no page for an element that is
        // hidden or has no area, and a chat's tabs must stay readable with
        // their pane closed.
        if(shown){size.current={width:Math.round(rect.width),height:Math.round(rect.height)};}
        host.style.width=`${size.current.width}px`;
        host.style.height=`${size.current.height}px`;
        host.style.transform=`translate(${Math.round(shown?rect.x:0)}px, ${Math.round(shown?rect.y:0)}px)`;
        host.style.zIndex=shown?'1':'-1';
        host.style.pointerEvents=shown?'auto':'none';
    };
    const position=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(apply);
    };
    place.current=position;
    // The host must have a real box before the page element goes into it:
    // Chromium creates no page for an element that never had one.
    apply();
    void api.browser.attach(tab.id).then(src=>{
      if(dropped)return;
      mounted=src;
      element=document.createElement('webview');
      // Only the src main just minted. Every other attribute is main's to set.
      element.setAttribute('src',src);
      // The page asking to close itself is the one case that removes the tab.
      element.addEventListener('close',()=>{void api.browser.close(tab.id).catch(()=>{});});
      // A video, or any page, going full screen fills the window, not the pane;
      // leaving it puts the page back where the pane is.
      element.addEventListener('enter-html-full-screen',()=>{full=true;host.classList.add('is-fullscreen');});
      element.addEventListener('leave-html-full-screen',()=>{full=false;host.classList.remove('is-fullscreen');position();});
      host.appendChild(element);
      position();
    }).catch((error:Error)=>{if(!dropped)setError(error.message);});
    const observer=new ResizeObserver(position);
    if(viewport.current)observer.observe(viewport.current);
    window.addEventListener('resize',position);
    window.addEventListener('scroll',position,true);
    position();
    return()=>{
      dropped=true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize',position);
      window.removeEventListener('scroll',position,true);
      place.current=()=>{};
      host.remove();
      // Name the page this host created, so a late unmount cannot close a newer one.
      void api.browser.detach(tab.id,mounted.split('hello-attach-')[1]).catch(()=>{});
    };
    // The page outlives a start page and a failed load: only a different tab,
    // or main asking for a fresh page, replaces it.
  },[tab.id,tab.generation??0]);
  const shownRef = useRef(visible);
  const pageRef = useRef(!isStartPage&&!tab.error);
  useEffect(()=>{
    shownRef.current=visible;
    pageRef.current=!isStartPage&&!tab.error;
    place.current();
  },[visible,isStartPage,tab.error]);
  useEffect(() => {
    const owner = Symbol(tab.id);
    if (visible) visiblePanes.set(owner, tab.id);
    publishVisibleBrowser();
    return () => {
      // On unmount, main's existing detach/close path clears the active page.
      // A visibility change publishes after the replacement effects register.
      visiblePanes.delete(owner);
    };
  }, [visible, tab.id]);
  const run=async(task:()=>Promise<unknown>)=>{setError('');try{await task();}catch(e){setError((e as Error).message);}};
  const navigate=()=>run(()=>api.browser.navigate(tab.id,address));
  const mode=modes.find(item=>item.value===tab.control)!;
  const pageMode=usePageMode(tab,visible);
  return <div className="browser-pane">
    <div className="browser-toolbar">
      <div className="browser-navigation">
        <button title="Back" aria-label="Back" disabled={!tab.canGoBack} onClick={()=>void run(()=>api.browser.action(tab.id,'back'))}><ArrowLeft size={16}/></button>
        <button title="Forward" aria-label="Forward" disabled={!tab.canGoForward} onClick={()=>void run(()=>api.browser.action(tab.id,'forward'))}><ArrowRight size={16}/></button>
        <button title={tab.loading?'Stop loading':'Reload'} aria-label={tab.loading?'Stop loading':'Reload'} onClick={()=>void run(()=>api.browser.action(tab.id,tab.loading?'stop':'reload'))}>{tab.loading?<X size={16}/>:<RotateCw size={16}/>}</button>
      </div>
      <form className="browser-address" onSubmit={event=>{event.preventDefault();void navigate();}}>
        {tab.loading && tab.progress !== null ? (
          <div className="browser-progress" role="progressbar" aria-valuenow={tab.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="browser-progress-fill" style={{width:`${tab.progress}%`}}/>
          </div>
        ) : tab.loading ? (
          <Loader2 size={14} className="browser-spinner"/>
        ) : (<Globe size={14}/>)}
        <input aria-label="Web address" placeholder="Search or enter address" value={address} onChange={event=>setAddress(event.target.value)} onFocus={event=>event.target.select()} spellCheck={false}/>
        <div className="browser-control-anchor" data-mode={tab.control}>
          <MenuButton key={`${tab.id}-${visible}`} className="agent-control-pill" label={`AI Mode: ${mode.label}`} menuLabel="AI Mode" items={modes.map(item=>({id:item.value,label:item.label,detail:item.detail,checked:tab.control===item.value,action:()=>void run(async()=>{onTabChange(await api.browser.control(tab.id,item.value));})}))}>
            <AIModeGlyph/><span>AI Mode</span>
          </MenuButton>
        </div>
      </form>
      <PageModeSwitch tab={tab} mode={pageMode.mode} pending={pageMode.pending} available={pageMode.available} onToggle={kind=>void pageMode.toggle(kind)}/>
      <DownloadsMenu conversationId={tab.conversationId} onError={setError}/>
      <button className="browser-quote" title={tab.control==='off'?'Enable read access to add this page to chat':'Add page to chat'} aria-label="Add page to chat" disabled={quoting||tab.control==='off'||tab.url==='about:blank'} onClick={()=>void run(async()=>{setQuoting(true);try{const page=await api.browser.read(tab.id);onQuote(`Page: ${page.title}\nSource: ${page.url}\n\n${page.text}`);}finally{setQuoting(false);}})}><MessageSquarePlus size={16}/></button>
    </div>
    {error&&<div className="browser-error" role="alert">{error}<button aria-label="Dismiss browser error" onClick={()=>setError('')}><X size={14}/></button></div>}
    {pageMode.error&&<div className="browser-error" role="alert">{pageMode.error}<button aria-label="Dismiss page mode error" onClick={pageMode.clearError}><X size={14}/></button></div>}
    <div ref={viewport} className="browser-viewport">
      {tab.error?<div className="browser-start"><Globe size={28}/><h2>Couldn’t open this page</h2><p>{tab.error}</p><button onClick={()=>void run(()=>api.browser.action(tab.id,'reload'))}>Try again</button></div>:isStartPage?<div className="browser-start"><Globe size={28}/><h2>A place to explore.</h2><p>Search the web, follow a reference, bring what matters back to your chat.</p><form onSubmit={event=>{event.preventDefault();void navigate();}}><input aria-label="Search the web" placeholder="Search or enter address" value={address} onChange={event=>setAddress(event.target.value)}/><button aria-label="Go to address"><ArrowRight size={16}/></button></form><small>{mode.detail}.</small></div>:null}
      {pageMode.mode==='design'&&pageMode.picked&&visible?<DesignComposer tab={tab} picked={pageMode.picked} slot={viewport} onQuote={onQuote} onRelease={pageMode.release} onExit={pageMode.disarm}/>:null}
      {pageMode.mode==='annotate'&&visible?<AnnotateBar tab={tab} marks={pageMode.marks} slot={viewport} onQuote={onQuote} onExit={pageMode.disarm}/>:null}
    </div>
  </div>;
}
