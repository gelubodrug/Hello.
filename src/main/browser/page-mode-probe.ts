// Page modes — the half that lives in the page.
//
// Ported from an earlier design-mode probe; see
// docs/PROVENANCE.md for what changed. Hello's guest has no preload and no
// initialization script, so main injects this when a mode is armed — and into
// an ISOLATED WORLD, not the page's own. The page shares the DOM with it but
// not a single JS object: it cannot read the queue, forge a pick, or switch the
// mode off. The one thing an isolated world cannot see is the page's own
// expandos (React's fiber), so a pick marks its element with a token and main
// asks the page world once, for that element only (FIBER_PROBE).
//
// There is no channel from a guest back to main without a preload, so main
// asks: `wait(armId, ms)` resolves the moment something happens, or after `ms`
// with nothing. That is a long poll, not a timer — a pick arrives at once.
//
// The overlay is a closed shadow root at the top of the stacking order; its
// sheet is constructed, so a page's style-src CSP cannot strip it.
//
// Kinds: `design` is here. `annotate` plugs into KINDS with the same shape
// (arm, move, click, exit, beforeShot, afterShot, plus any command reached
// through `call`). Until it does, arming it answers false.

/** Isolated world page modes run in. Electron's own preload world is 999. */
export const PAGE_MODE_WORLD_ID = 1207;

/** Upper bound on one long poll; the page answers sooner when anything happens. */
export const PAGE_MODE_WAIT_MS = 400;

export const PAGE_MODE_PROBE = String.raw`(function(){
  var W=window;
  if(W.__HELLO_PAGE_MODE__)return true;
  var S={armed:false,kind:null,armId:null,queue:[],waiters:[],host:null,root:null,ring:null,
    hoverEl:null,picked:null,token:null,shots:0,frame:0};
  Object.defineProperty(W,"__HELLO_PAGE_MODE__",{value:S});

  function rectOf(el){
    var r=el.getBoundingClientRect();
    return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};
  }
  function textOf(el){return (el.textContent||"").replace(/\s+/g," ").trim().slice(0,140);}
  function shortDomPath(node){
    var parts=[],el=node;
    for(var i=0;el&&el.nodeType===1&&i<4&&el!==document.body;i++){
      var t=el.tagName.toLowerCase();
      if(el.id)t+="#"+el.id;
      else if(typeof el.className==="string"&&el.className.trim())
        t+="."+el.className.trim().split(/\s+/).slice(0,4).join(".");
      parts.unshift(t);
      el=el.parentElement;
    }
    return parts.join(" > ");
  }
  function styleSummary(node){
    var s=getComputedStyle(node),parts=[];
    if(s.fontSize)parts.push("font "+s.fontSize+"/"+s.fontWeight);
    if(s.color)parts.push("color "+s.color);
    if(s.backgroundColor&&s.backgroundColor!=="rgba(0, 0, 0, 0)"&&s.backgroundColor!=="transparent")parts.push("bg "+s.backgroundColor);
    if(s.padding&&s.padding!=="0px")parts.push("pad "+s.padding);
    if(s.margin&&s.margin!=="0px")parts.push("margin "+s.margin);
    if(s.borderRadius&&s.borderRadius!=="0px")parts.push("radius "+s.borderRadius);
    if(s.borderTopWidth&&s.borderTopWidth!=="0px")
      parts.push("border "+s.borderTopWidth+" "+s.borderTopStyle+" "+s.borderTopColor);
    if(/flex|grid/.test(s.display||""))
      parts.push(s.display+(s.gap&&s.gap!=="normal"?" gap "+s.gap:""));
    return parts.join(" · ");
  }
  var escape=W.CSS&&typeof W.CSS.escape==="function"?function(v){return W.CSS.escape(v);}
    :function(v){return String(v).replace(/[^a-zA-Z0-9_-]/g,function(c){return "\\"+c;});};
  function cssPath(el){
    if(!el||el.nodeType!==1)return "";
    if(el.id)return "#"+escape(el.id);
    var parts=[],node=el,depth=0;
    while(node&&node.nodeType===1&&depth<6){
      var part=node.tagName.toLowerCase();
      if(node.id){parts.unshift("#"+escape(node.id));break;}
      var parent=node.parentElement;
      if(parent){
        var same=Array.prototype.filter.call(parent.children,function(c){return c.tagName===node.tagName;});
        if(same.length>1)part+=":nth-of-type("+(same.indexOf(node)+1)+")";
      }
      parts.unshift(part);
      node=parent;depth++;
    }
    return parts.join(" > ");
  }

  // ── Queue: what main takes on its next wait ──────────────────────────────
  function wake(){var w=S.waiters;S.waiters=[];for(var i=0;i<w.length;i++)w[i]();}
  function emit(ev){
    // Only the latest highlight matters; a pick is never dropped for one.
    if(ev.type==="hover"){
      for(var i=S.queue.length-1;i>=0;i--)if(S.queue[i].type==="hover")S.queue.splice(i,1);
    }
    S.queue.push(ev);
    if(S.queue.length>50)S.queue.splice(0,S.queue.length-50);
    wake();
  }

  // ── Overlay ──────────────────────────────────────────────────────────────
  var CSS_TEXT=
    ".ring{position:fixed;left:0;top:0;width:0;height:0;display:none;box-sizing:border-box;"+
    "border:1.5px solid #0a84ff;border-radius:4px;background:rgba(10,132,255,.08);"+
    "box-shadow:0 0 0 1px rgba(255,255,255,.55);pointer-events:none;"+
    "transition:left 60ms linear,top 60ms linear,width 60ms linear,height 60ms linear}"+
    ".ring.on{display:block}"+
    ".ring.picked{border-width:2px;background:rgba(10,132,255,.12);transition:none}"+
    "@media (prefers-reduced-motion:reduce){.ring{transition:none}}";
  function ensureUi(){
    if(!S.host){
      var host=document.createElement("div");
      host.setAttribute("data-hello-page-mode","");
      var st=host.style;
      st.setProperty("position","fixed","important");
      st.setProperty("inset","0","important");
      st.setProperty("z-index","2147483647","important");
      st.setProperty("pointer-events","none","important");
      st.setProperty("display","block","important");
      var root=host.attachShadow({mode:"closed"});
      try{
        var sheet=new CSSStyleSheet();
        sheet.replaceSync(CSS_TEXT);
        root.adoptedStyleSheets=[sheet];
      }catch(_){
        var tag=document.createElement("style");
        tag.textContent=CSS_TEXT;
        root.appendChild(tag);
      }
      S.ring=document.createElement("div");
      S.ring.className="ring";
      root.appendChild(S.ring);
      S.host=host;S.root=root;
    }
    if(!S.host.isConnected)(document.documentElement||document.body).appendChild(S.host);
  }
  function place(rect){
    if(!S.ring)return;
    if(!rect){S.ring.classList.remove("on");return;}
    S.ring.style.left=rect.x+"px";
    S.ring.style.top=rect.y+"px";
    S.ring.style.width=rect.w+"px";
    S.ring.style.height=rect.h+"px";
    S.ring.classList.add("on");
  }
  function inOverlay(e){
    var path=e.composedPath?e.composedPath():[e.target];
    for(var i=0;i<path.length;i++)if(path[i]===S.host)return true;
    return false;
  }

  // ── Pick ─────────────────────────────────────────────────────────────────
  function clearToken(){
    if(!S.token)return;
    try{
      var el=document.querySelector('[data-hello-pick="'+S.token+'"]');
      if(el)el.removeAttribute("data-hello-pick");
    }catch(_){}
    S.token=null;
  }
  function release(fromPage){
    var had=!!S.picked;
    clearToken();
    S.picked=null;S.hoverEl=null;
    if(S.ring)S.ring.classList.remove("picked");
    place(null);
    if(fromPage&&had)emit({type:"released"});
  }
  function pick(el,e){
    release(false);
    var token="";
    for(var i=0;i<3;i++)token+=Math.random().toString(36).slice(2,10);
    token=token.replace(/[^a-z0-9]/g,"")||"t"+Date.now();
    S.token=token;S.picked=el;
    try{el.setAttribute("data-hello-pick",token);}catch(_){}
    var r=rectOf(el);
    place(r);
    S.ring.classList.add("picked");
    emit({type:"pick",token:token,tag:el.tagName.toLowerCase(),selector:cssPath(el),text:textOf(el),
      styles:styleSummary(el),dom:shortDomPath(el),url:location.href,rect:r,
      point:{x:Math.round(e.clientX),y:Math.round(e.clientY)},viewport:{w:W.innerWidth,h:W.innerHeight}});
  }

  var KINDS={};
  KINDS.design={
    move:function(e){
      if(S.picked)return;
      var el=e.target;
      if(!el||el.nodeType!==1||el===S.host||el===S.hoverEl)return;
      S.hoverEl=el;
      var r=rectOf(el);
      place(r);
      emit({type:"hover",rect:r});
    },
    // A click away from a pick ends it and does nothing else — the same rule
    // as the bubble it was ported from: no Cancel button to aim at.
    click:function(e){
      var el=e.target;
      if(S.picked){
        release(true);
        if(el&&el.nodeType===1){S.hoverEl=el;var r=rectOf(el);place(r);emit({type:"hover",rect:r});}
        return;
      }
      if(el&&el.nodeType===1)pick(el,e);
    }
  };
  // KINDS.annotate — added by the Annotate lane.

  // ── Listeners ────────────────────────────────────────────────────────────
  var PRESSES=["pointerdown","mousedown","pointerup","mouseup","dblclick","auxclick","contextmenu","touchstart","touchend"];
  function swallow(e){
    if(!S.armed||inOverlay(e))return;
    e.preventDefault();e.stopImmediatePropagation();
  }
  function onClick(e){
    if(!S.armed||inOverlay(e))return;
    e.preventDefault();e.stopImmediatePropagation();
    var k=KINDS[S.kind];
    if(k&&k.click)k.click(e);
  }
  function onMove(e){
    if(!S.armed)return;
    var k=KINDS[S.kind];
    if(k&&k.move)k.move(e);
  }
  function onOut(e){
    if(!S.armed||S.picked||e.relatedTarget)return;
    S.hoverEl=null;place(null);emit({type:"hover",rect:null});
  }
  // The highlight follows the page as it scrolls or reflows, once per frame.
  function onScroll(){
    if(!S.armed||S.frame)return;
    S.frame=W.requestAnimationFrame(function(){
      S.frame=0;
      var el=S.picked||S.hoverEl;
      if(!S.armed||!el)return;
      if(!el.isConnected){if(S.picked)release(true);else{S.hoverEl=null;place(null);emit({type:"hover",rect:null});}return;}
      var r=rectOf(el);
      place(r);
      emit({type:"hover",rect:r});
    });
  }
  function listen(on){
    var method=on?"addEventListener":"removeEventListener";
    for(var i=0;i<PRESSES.length;i++)W[method](PRESSES[i],swallow,true);
    W[method]("click",onClick,true);
    W[method]("mousemove",onMove,true);
    W[method]("mouseout",onOut,true);
    W[method]("scroll",onScroll,true);
    W[method]("resize",onScroll,true);
  }

  // ── Bridge ───────────────────────────────────────────────────────────────
  S.kinds=function(){return Object.keys(KINDS);};
  S.arm=function(kind,armId){
    if(!KINDS[kind]||typeof armId!=="string"||!armId)return false;
    if(S.armed)S.disarm();
    ensureUi();
    S.kind=kind;S.armId=armId;S.armed=true;S.queue=[];
    listen(true);
    if(KINDS[kind].arm)KINDS[kind].arm();
    return true;
  };
  // armId names the arming the caller means to end: a late disarm from an
  // arming that was already replaced must not end its successor.
  S.disarm=function(armId){
    if(armId&&armId!==S.armId)return false;
    if(!S.armed)return true;
    var k=KINDS[S.kind];
    if(k&&k.exit)k.exit();
    S.armed=false;
    release(false);
    listen(false);
    if(S.frame){W.cancelAnimationFrame(S.frame);S.frame=0;}
    if(S.host)S.host.remove();
    S.armId=null;S.kind=null;S.queue=[];
    wake();
    return true;
  };
  S.release=function(armId){
    if(!S.armed||armId!==S.armId)return false;
    release(false);
    return true;
  };
  S.wait=function(armId,ms){
    return new Promise(function(resolve){
      var done=false,timer=0;
      function finish(){
        if(done)return;
        done=true;
        clearTimeout(timer);
        var at=S.waiters.indexOf(finish);
        if(at>=0)S.waiters.splice(at,1);
        if(!S.armed||S.armId!==armId){resolve(null);return;}
        var events=S.queue;S.queue=[];
        resolve({armId:armId,events:events});
      }
      if(S.queue.length||!S.armed||S.armId!==armId){finish();return;}
      S.waiters.push(finish);
      timer=setTimeout(finish,Math.max(50,Math.min(5000,Number(ms)||400)));
    });
  };
  /** Before a picture: our overlay leaves it, the kind gets its say, and the
   *  page has painted once without them. Answers the viewport the picture is of. */
  S.beforeShot=function(){
    S.shots++;
    if(S.host)S.host.style.setProperty("visibility","hidden","important");
    var k=S.armed&&KINDS[S.kind];
    var extra=k&&k.beforeShot?k.beforeShot():null;
    return new Promise(function(resolve){
      var sent=false;
      function go(){
        if(sent)return;
        sent=true;
        resolve({viewport:{w:W.innerWidth,h:W.innerHeight},extra:extra===undefined?null:extra});
      }
      try{W.requestAnimationFrame(function(){W.requestAnimationFrame(go);});}catch(_){}
      setTimeout(go,120);
    });
  };
  S.afterShot=function(){
    S.shots=Math.max(0,S.shots-1);
    if(!S.shots&&S.host)S.host.style.removeProperty("visibility");
    var k=S.armed&&KINDS[S.kind];
    if(k&&k.afterShot)k.afterShot();
    return true;
  };
  /** A kind's own command, only while that kind is the one armed. */
  S.call=function(kind,method,args){
    var k=KINDS[kind];
    if(!S.armed||S.kind!==kind||!k||typeof k[method]!=="function")return null;
    return k[method].apply(null,Array.isArray(args)?args:[]);
  };
  return true;
})()`;

/** An expression that runs one bridge method, or yields `fallback` when the probe is absent. */
export function probeCall(method: string, args: unknown[] = [], fallback = 'null'): string {
  if (!/^[a-zA-Z]+$/.test(method)) throw new Error('Invalid page mode method.');
  const list = args.map(value => JSON.stringify(value ?? null)).join(',');
  return `(window.__HELLO_PAGE_MODE__?window.__HELLO_PAGE_MODE__.${method}(${list}):${fallback})`;
}

/**
 * Runs in the PAGE's world, once per pick: React keeps its fiber as an expando
 * on the DOM node, which only the page's own world can see. Everything it
 * returns came from page code and is checked in main like anything else.
 * Ported from an earlier getFiber / componentTrail / debugSourceOf.
 */
export function fiberProbe(token: string): string {
  if (!/^[a-z0-9]{1,64}$/i.test(token)) throw new Error('Invalid pick token.');
  return String.raw`(function(token){
  var el=document.querySelector('[data-hello-pick="'+token+'"]');
  if(!el)return null;
  el.removeAttribute("data-hello-pick");
  var PREFIXES=["__reactFiber$","__reactInternalInstance$"];
  var SECTION=/(Section|Panel|Dialog|View|Screen|Page|Sidebar|Bar|Pane|App|Card|Inbox)$/;
  function getFiber(node){
    try{
      var keys=Object.keys(node);
      for(var i=0;i<keys.length;i++)for(var j=0;j<PREFIXES.length;j++)
        if(keys[i].indexOf(PREFIXES[j])===0)return node[keys[i]];
    }catch(_){}
    return null;
  }
  function componentName(type){
    if(!type||typeof type==="string")return null;
    var n=type.displayName||type.name||(type.render&&(type.render.displayName||type.render.name))||
      (type.type&&(type.type.displayName||type.type.name));
    return typeof n==="string"&&/^[A-Z]/.test(n)?n:null;
  }
  function componentTrail(fiber){
    var names=[],f=fiber;
    for(var i=0;f&&i<60;i++){
      var n=componentName(f.type);
      if(n&&names[names.length-1]!==n)names.push(n);
      f=f._debugOwner||f.return;
    }
    if(!names.length)return null;
    var immediate=names[0],section=null;
    for(var k=0;k<names.length;k++)if(SECTION.test(names[k])){section=names[k];break;}
    return section&&section!==immediate?section+" › "+immediate:immediate;
  }
  function debugSourceOf(fiber){
    var f=fiber;
    for(var i=0;f&&i<40;i++){
      var src=f._debugSource;
      if(src&&typeof src.fileName==="string"){
        return src.fileName.replace(/^.*?\/(src\/.*)$/,"$1")+":"+src.lineNumber+(src.columnNumber?":"+src.columnNumber:"");
      }
      f=f._debugOwner||f.return;
    }
    return null;
  }
  var fiber=getFiber(el);
  if(!fiber)return {component:null,file:null};
  return {component:componentTrail(fiber),file:debugSourceOf(fiber)};
})(` + JSON.stringify(token) + ')';
}
