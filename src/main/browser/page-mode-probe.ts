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
// Kinds: `design` and `annotate`, each with the same shape (arm, move, click,
// exit, beforeShot, afterShot, plus any command reached through `call`).

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
  function inHost(e,host){
    if(!host)return false;
    var path=e.composedPath?e.composedPath():[e.target];
    for(var i=0;i<path.length;i++)if(path[i]===host)return true;
    return false;
  }
  function inOverlay(e){return inHost(e,S.host);}

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
  // Ported from an earlier annotate probe.
  // Design names an element; Annotate marks a ZONE: a numbered, coloured pin
  // dropped where the click was, with a sentence beside it. The pins live in
  // their own layer at the document origin, so they scroll with the page — and
  // that layer is NOT the overlay, so they stay in the picture (beforeShot hides
  // only the note still being typed). Numbers are stable: removing #2 does not
  // renumber #3, someone may already have read "#3". Everything is this page's
  // memory only; leaving the mode or the document forgets it.
  var MARK_COLORS=[["yellow","#f5c542"],["blue","#4c8dff"],["pink","#ff5fa2"],
    ["green","#3ecf8e"],["orange","#ff8a3d"],["purple","#a77bff"]];
  var MARK_CSS=
    ".mark{position:absolute;width:0;height:0;pointer-events:none}"+
    ".pinwrap{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;filter:drop-shadow(0 3px 8px rgba(0,0,0,.45))}"+
    ".pin{position:absolute;left:0;top:-24px;width:24px;height:24px;border-radius:50% 50% 50% 0;transform-origin:0 100%;"+
    "display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 0 0 2px rgba(0,0,0,.55);pointer-events:auto}"+
    ".pin span{font:700 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#111}"+
    ".label{position:absolute;left:0;top:0;width:max-content;max-width:240px;box-sizing:border-box;background:#1e1e1e;color:#d4d4d4;"+
    "border-radius:8px;padding:5px 9px;font:400 13px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:pre-wrap;"+
    "word-break:break-word;border-left:3px solid var(--c);box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:auto;"+
    "transition:left .08s ease-out,top .08s ease-out}"+
    ".label input{background:transparent;border:0;outline:none;color:#d4d4d4;font:inherit;width:210px;padding:0}"+
    ".label input::placeholder{color:#6f6f6f}"+
    ".mark.appear .pinwrap{animation:markPop .22s cubic-bezier(.2,.8,.2,1) both}"+
    ".mark.appear .label{animation:markLabel .26s cubic-bezier(.2,.8,.2,1) both}"+
    "@keyframes markPop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}"+
    "@keyframes markLabel{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:none}}"+
    "@media (prefers-reduced-motion:reduce){.mark.appear .pinwrap,.mark.appear .label{animation:none}.label{transition:none}}";
  // How far the pin reaches from its point; the label keeps a gap beyond it.
  var PIN_REACH=35;
  var A={host:null,root:null,marks:[],pending:null,nextN:1,cursor:null};

  function ensureMarks(){
    if(!A.host){
      var host=document.createElement("div");
      host.setAttribute("data-hello-annotations","");
      var st=host.style;
      // Absolute at the document origin, so the pins scroll WITH the page.
      st.setProperty("position","absolute","important");
      st.setProperty("left","0","important");
      st.setProperty("top","0","important");
      st.setProperty("width","0","important");
      st.setProperty("height","0","important");
      st.setProperty("z-index","2147483646","important");
      st.setProperty("pointer-events","none","important");
      st.setProperty("display","block","important");
      var root=host.attachShadow({mode:"closed"});
      try{
        var sheet=new CSSStyleSheet();
        sheet.replaceSync(MARK_CSS);
        root.adoptedStyleSheets=[sheet];
      }catch(_){
        var tag=document.createElement("style");
        tag.textContent=MARK_CSS;
        root.appendChild(tag);
      }
      // Typing a note is not typing on the page: its keys (site hotkeys) and the
      // presses that place the caret end at this layer, in the bubble phase.
      var own=["keydown","keyup","keypress"].concat(PRESSES);
      for(var j=0;j<own.length;j++)root.addEventListener(own[j],function(ev){ev.stopPropagation();});
      A.host=host;A.root=root;
    }
    if(!A.host.isConnected)(document.documentElement||document.body).appendChild(A.host);
  }
  /** Lay a marker out along its angle; the label's nearest edge stays PIN_REACH from the point. */
  function layoutMark(m){
    var deg=m.angle*180/Math.PI+45;
    m.pin.style.transform="rotate("+deg+"deg)";
    m.num.style.transform="rotate("+(-deg)+"deg)";
    var w=m.label.offsetWidth,h=m.label.offsetHeight;
    var ux=Math.cos(m.angle),uy=Math.sin(m.angle);
    var reach=PIN_REACH+Math.abs(ux)*w/2+Math.abs(uy)*h/2;
    m.label.style.left=Math.round(ux*reach-w/2)+"px";
    m.label.style.top=Math.round(uy*reach-h/2)+"px";
  }
  function inMarks(e){return inHost(e,A.host);}
  function hits(node,e){
    if(!node)return false;
    var r=node.getBoundingClientRect();
    return e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;
  }
  function markCount(){return A.marks.length;}
  function dropPending(){
    var p=A.pending;
    if(!p)return;
    A.pending=null;
    try{p.input.blur();}catch(_){}
    p.node.remove();
  }
  function commitPending(){
    var p=A.pending;
    if(!p)return;
    A.pending=null;
    var t=(p.input.value||"").replace(/\s+/g," ").trim().slice(0,1000);
    // Leave the field first, so nothing can put the caret back into a finished note.
    try{p.input.blur();}catch(_){}
    // A marker with no words is not an annotation.
    if(!t){p.node.remove();return;}
    p.label.textContent=t;
    layoutMark(p);
    var token="";
    if(p.target&&p.target.isConnected){
      for(var i=0;i<2;i++)token+=Math.random().toString(36).slice(2,10);
      token=token.replace(/[^a-z0-9]/g,"")||"m"+Date.now();
      try{p.target.setAttribute("data-hello-pick",token);}catch(_){token="";}
    }
    A.marks.push({n:p.n,color:p.color,text:t,at:p.at,tag:p.tag,token:token,node:p.node,pin:p.pin,target:p.target});
    var ev={type:"marks",count:markCount()};
    // Main reads the component under the marker once, from the page world, and hands it back through setAt.
    if(token)ev.mark={n:p.n,token:token};
    emit(ev);
  }
  function clearMarkToken(m){
    if(!m.token)return;
    try{if(m.target&&m.target.getAttribute("data-hello-pick")===m.token)m.target.removeAttribute("data-hello-pick");}catch(_){}
    m.token="";
  }
  function removeMark(n){
    if(A.pending&&A.pending.n===n){dropPending();return;}
    for(var i=0;i<A.marks.length;i++){
      if(A.marks[i].n===n){
        clearMarkToken(A.marks[i]);
        A.marks[i].node.remove();
        A.marks.splice(i,1);
        emit({type:"marks",count:markCount()});
        return;
      }
    }
  }
  function placeMark(e){
    ensureMarks();
    var cx=e.clientX,cy=e.clientY,x=cx+W.scrollX,y=cy+W.scrollY;
    var n=A.nextN++;
    var c=MARK_COLORS[(n-1)%MARK_COLORS.length];
    var node=document.createElement("div");
    node.className="mark appear";
    node.style.left=x+"px";
    node.style.top=y+"px";
    node.style.setProperty("--c",c[1]);
    // Up and to the right like a pin; left near the right edge, down near the top.
    var angle=(cx>W.innerWidth-300?-3:-1)*Math.PI/4;
    if(cy<90)angle=-angle;
    var wrap=document.createElement("div");
    wrap.className="pinwrap";
    var pin=document.createElement("div");
    pin.className="pin";
    pin.style.background=c[1];
    pin.title="Remove #"+n;
    var num=document.createElement("span");
    num.textContent=String(n);
    pin.appendChild(num);
    wrap.appendChild(pin);
    var label=document.createElement("div");
    label.className="label";
    var input=document.createElement("input");
    input.type="text";
    input.maxLength=1000;
    input.placeholder="#"+n+" what is wrong or wanted here";
    input.setAttribute("aria-label","Note for marker "+n);
    label.appendChild(input);
    node.appendChild(wrap);node.appendChild(label);
    A.root.appendChild(node);
    var target=e.target&&e.target.nodeType===1?e.target:null;
    A.pending={n:n,color:c[0],at:target?shortDomPath(target):"",tag:target?target.tagName.toLowerCase():"",
      target:target,node:node,label:label,input:input,pin:pin,num:num,angle:angle,x:x,y:y};
    layoutMark(A.pending);
    input.addEventListener("keydown",function(ev){
      // Escape never reaches the page: main catches it and ends the mode, which drops this note.
      if(ev.key==="Enter"&&!ev.isComposing){ev.preventDefault();commitPending();}
    });
    focusPending();
  }
  function focusPending(){
    var p=A.pending;
    // preventScroll: a note swung past the edge must not drag the page under its point.
    if(p)setTimeout(function(){if(A.pending===p)try{p.input.focus({preventScroll:true});}catch(_){}},0);
  }
  KINDS.annotate={
    arm:function(){
      ensureMarks();
      A.cursor=document.documentElement.style.getPropertyValue("cursor");
      document.documentElement.style.setProperty("cursor","crosshair");
    },
    /** While a note is written its direction follows the mouse; over the note itself it holds still. */
    move:function(e){
      var p=A.pending;
      if(!p||hits(p.label,e))return;
      var dx=e.clientX+W.scrollX-p.x,dy=e.clientY+W.scrollY-p.y;
      if(dx*dx+dy*dy<16*16)return;
      p.angle=Math.atan2(dy,dx);
      layoutMark(p);
    },
    // The core has already kept the click from the page. Our own layer's
    // clicks arrive here too, so they are sorted by where they landed.
    click:function(e){
      if(inMarks(e)){
        if(A.pending&&hits(A.pending.label,e)){focusPending();return;}
        var all=A.pending?A.marks.concat([A.pending]):A.marks;
        for(var i=all.length-1;i>=0;i--){
          if(all[i].node.firstChild&&hits(all[i].node.firstChild.firstChild,e)){removeMark(all[i].n);return;}
        }
        return;
      }
      // A click away from an open note closes it — kept with words, dropped
      // without — and does nothing else (user, 13.09).
      if(A.pending){commitPending();return;}
      placeMark(e);
    },
    exit:function(){
      dropPending();
      for(var i=0;i<A.marks.length;i++){clearMarkToken(A.marks[i]);A.marks[i].node.remove();}
      A.marks=[];A.nextN=1;
      if(A.host)A.host.remove();
      if(A.cursor)document.documentElement.style.setProperty("cursor",A.cursor);
      else document.documentElement.style.removeProperty("cursor");
      A.cursor=null;
    },
    /** A note with words goes with the picture as if committed; an empty one leaves
     *  it. Every committed pin says whether it is in the picture. */
    beforeShot:function(){
      // Send/Copy with a note still open means the person meant it (coordinator, 13.09).
      if(A.pending&&(A.pending.input.value||"").trim())commitPending();
      // Opacity, not visibility: a field that turns invisible loses focus, and its words with it.
      if(A.pending)A.pending.node.style.opacity="0";
      var out=[],vw=W.innerWidth,vh=W.innerHeight,shown=!!A.host&&A.host.isConnected;
      for(var i=0;i<A.marks.length;i++){
        var m=A.marks[i],r=m.node.getBoundingClientRect(),pr=m.pin.getBoundingClientRect();
        // A layer the page detached or collapsed measures zero: those pins are not in the picture.
        out.push({n:m.n,color:m.color,text:m.text,at:m.at,
          inView:shown&&pr.width>0&&pr.height>0&&r.top>=0&&r.left>=0&&r.top<vh&&r.left<vw});
      }
      return {marks:out};
    },
    afterShot:function(){
      if(A.pending)A.pending.node.style.opacity="";
    },
    /** Main's reading of the component under marker n, for the arming that asked. */
    setAt:function(armId,n,component,file){
      if(armId!==S.armId||typeof component!=="string"||!component)return false;
      for(var i=0;i<A.marks.length;i++){
        var m=A.marks[i];
        if(m.n!==n)continue;
        m.at=component+(m.tag?" <"+m.tag+">":"")+(typeof file==="string"&&file?" ("+file+")":"");
        m.token="";
        return true;
      }
      return false;
    }
  };

  // ── Listeners ────────────────────────────────────────────────────────────
  var PRESSES=["pointerdown","mousedown","pointerup","mouseup","dblclick","auxclick","contextmenu","touchstart","touchend"];
  // Only the person's own input is a pick. A click a script made — the page's,
  // or an agent's el.click() under Full — goes to the page as if no mode were on.
  function swallow(e){
    // Presses in the marker layer keep their default (caret, selection); the layer stops them itself.
    if(!e.isTrusted||!S.armed||inOverlay(e)||inHost(e,A.host))return;
    e.preventDefault();e.stopImmediatePropagation();
  }
  function onClick(e){
    if(!e.isTrusted||!S.armed||inOverlay(e))return;
    e.preventDefault();e.stopImmediatePropagation();
    var k=KINDS[S.kind];
    if(k&&k.click)k.click(e);
  }
  function onMove(e){
    if(!e.isTrusted||!S.armed)return;
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

  // ── Marks an agent places (user, 30.09) ─────────────────────────────────
  // "A pointer for agents": after finding something, the agent shows the
  // person where to look (browser_mark). Annotate's own pins and notes, each
  // with an outline around the element it means, on a layer of their own — so
  // never among the person's markers, their Send or their exit. Page
  // coordinates like the person's: they scroll with the page. A chat bubble at
  // the left keeps the index: on hover it lists them, a click scrolls to one.
  // Each has an ×; what the person keeps is what main keeps with the page.
  var HINT_CSS=MARK_CSS+
    ".box{position:absolute;box-sizing:border-box;border:2px solid var(--c);border-radius:8px;pointer-events:none;"+
    "box-shadow:0 0 0 4px rgba(0,0,0,.18),0 0 18px var(--c)}"+
    ".box.appear,.hint.appear .pinwrap,.hint.appear .label{animation-delay:var(--d,0ms)}"+
    ".box.appear{animation:markLabel .26s cubic-bezier(.2,.8,.2,1) both}"+
    ".box.pulse{animation:hintPulse 1.1s ease-out 2}"+
    "@keyframes hintPulse{0%{box-shadow:0 0 0 0 var(--c)}100%{box-shadow:0 0 0 14px rgba(0,0,0,0)}}"+
    ".hint .label{display:flex;align-items:flex-start;gap:6px;padding-right:5px}"+
    ".x{flex:none;width:18px;height:18px;margin:-1px -1px 0 2px;border:0;border-radius:50%;background:transparent;color:#8a8a8a;"+
    "font:600 14px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;cursor:pointer;padding:0}"+
    ".x:hover{background:rgba(255,255,255,.12);color:#fff}"+
    ".dock{position:fixed;left:12px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px;pointer-events:auto;"+
    "font:400 13px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}"+
    ".bubble{position:relative;width:38px;height:38px;border-radius:50%;border:0;background:#1e1e1e;color:#e8e8e8;cursor:pointer;"+
    "display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.45);padding:0}"+
    ".bubble svg{width:19px;height:19px}"+
    ".count{position:absolute;right:-3px;top:-3px;min-width:17px;height:17px;border-radius:9px;background:#f5c542;color:#111;"+
    "font:700 11px/17px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;padding:0 4px;box-sizing:border-box}"+
    ".list{display:none;flex-direction:column;gap:6px;max-height:70vh;overflow:auto;padding:2px}"+
    ".dock:hover .list,.dock:focus-within .list{display:flex;animation:markLabel .18s cubic-bezier(.2,.8,.2,1) both}"+
    ".chip{display:flex;align-items:center;gap:6px;width:240px;box-sizing:border-box;background:#1e1e1e;color:#d4d4d4;border:0;"+
    "border-left:3px solid var(--c);border-radius:8px;padding:6px 6px 6px 9px;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;text-align:left;font:inherit}"+
    ".chip:hover{background:#262626}"+
    ".chip .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"+
    "@media (prefers-reduced-motion:reduce){.box.appear,.box.pulse,.dock:hover .list,.dock:focus-within .list{animation:none}}";
  // Built node by node: some pages refuse markup given as a string.
  function bubbleIcon(){
    var ns="http://www.w3.org/2000/svg";
    var svg=document.createElementNS(ns,"svg");
    var attrs={viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"};
    for(var k in attrs)svg.setAttribute(k,attrs[k]);
    var path=document.createElementNS(ns,"path");
    path.setAttribute("d","M7.9 20A9 9 0 1 0 4 16.1L2 22Z");
    svg.appendChild(path);
    return svg;
  }
  var H={host:null,root:null,marks:[],dock:null,waiters:[],frame:0,timer:0,listening:false};
  function hintsState(){return H.marks.map(function(m){return {n:m.n,x:m.x,y:m.y,width:m.width,height:m.height};});}
  function hintsChanged(){
    var waiters=H.waiters;H.waiters=[];
    for(var i=0;i<waiters.length;i++)waiters[i](hintsState());
  }
  // A mark stays on its element (user, 30.09: "tied to the marked elements…
  // arranged back even when the page is resized"): it follows the element's
  // box through a resize, a scroll inside the page, content that arrives and
  // moves it; a node the page rendered again is found by its path; a hidden
  // one hides its mark. One layout per frame, whatever asked for it.
  function scheduleHints(){
    if(H.frame||!H.marks.length)return;
    var run=function(){H.frame=0;layoutHints();};
    H.frame=W.requestAnimationFrame?W.requestAnimationFrame(run):setTimeout(run,16);
  }
  function listenHints(on){
    if(on===H.listening)return;
    H.listening=on;
    var method=on?"addEventListener":"removeEventListener";
    W[method]("resize",scheduleHints,true);
    // Capture: a scroll inside any container moves what it holds.
    document[method]("scroll",scheduleHints,{capture:true,passive:true});
    if(on)H.timer=setInterval(scheduleHints,600);
    else{clearInterval(H.timer);H.timer=0;if(H.frame){(W.cancelAnimationFrame||clearTimeout)(H.frame);H.frame=0;}}
  }
  function anchorOf(m){
    var el=m.el;
    if((!el||!el.isConnected)&&m.path){try{el=document.querySelector(m.path);}catch(_){el=null;}}
    m.el=el&&el.isConnected?el:null;
    return m.el;
  }
  // An inline element around a whole card has no width of its own: its content's box is the card.
  function boxOf(el){
    var own=el.getBoundingClientRect();
    if((own.width&&own.height)||!el.firstElementChild)return own;
    try{
      var range=document.createRange();
      range.selectNodeContents(el);
      var inner=typeof range.getBoundingClientRect==="function"?range.getBoundingClientRect():null;
      return inner&&inner.width&&inner.height?inner:own;
    }catch(_){return own;}
  }
  function placeHint(m){
    var el=anchorOf(m);
    if(el){
      var r=boxOf(el);
      // Its element hidden (a closed menu, a collapsed row): so is the mark.
      var shown=r.width>0||r.height>0;
      m.box.style.visibility=m.node.style.visibility=shown?"":"hidden";
      if(shown){m.x=Math.round(r.left+W.scrollX);m.y=Math.round(r.top+W.scrollY);m.width=Math.round(r.width);m.height=Math.round(r.height);}
    }
    m.box.style.left=m.x+"px";m.box.style.top=m.y+"px";
    m.box.style.width=m.width+"px";m.box.style.height=m.height+"px";
    m.node.style.left=m.x+"px";m.node.style.top=m.y+"px";
    // From the outline's corner, up and to the right like the person's pin.
    var vx=m.x-W.scrollX,vy=m.y-W.scrollY;
    var angle=(vx>W.innerWidth-300?-3:-1)*Math.PI/4;
    if(vy<90)angle=-angle;
    if(angle!==m.angle){m.angle=angle;layoutMark(m);}
  }
  function layoutHints(){for(var i=0;i<H.marks.length;i++)placeHint(H.marks[i]);}
  function clearHints(){
    listenHints(false);
    if(H.host)H.host.remove();
    H.host=null;H.root=null;H.marks=[];H.dock=null;
    hintsChanged();
  }
  function ensureHints(){
    var host=document.createElement("div");
    host.setAttribute("data-hello-hints","");
    var st=host.style;
    st.setProperty("position","absolute","important");
    st.setProperty("left","0","important");
    st.setProperty("top","0","important");
    st.setProperty("width","0","important");
    st.setProperty("height","0","important");
    st.setProperty("z-index","2147483645","important");
    st.setProperty("pointer-events","none","important");
    st.setProperty("display","block","important");
    var root=host.attachShadow({mode:"closed"});
    try{
      var sheet=new CSSStyleSheet();
      sheet.replaceSync(HINT_CSS);
      root.adoptedStyleSheets=[sheet];
    }catch(_){
      var tag=document.createElement("style");
      tag.textContent=HINT_CSS;
      root.appendChild(tag);
    }
    // A press on a mark or the index is not a press on the page under it.
    for(var j=0;j<PRESSES.length;j++)root.addEventListener(PRESSES[j],function(ev){ev.stopPropagation();});
    root.addEventListener("click",function(ev){ev.stopPropagation();});
    (document.documentElement||document.body).appendChild(host);
    H.host=host;H.root=root;
  }
  function removeHint(n){
    var at=-1;
    for(var i=0;i<H.marks.length;i++)if(H.marks[i].n===n)at=i;
    if(at<0)return;
    var m=H.marks.splice(at,1)[0];
    m.box.remove();m.node.remove();if(m.chip)m.chip.remove();
    if(!H.marks.length)clearHints();
    else{renderDock();hintsChanged();}
  }
  function evaporateHints(){
    var host=H.host;
    if(!host)return;
    var still=W.matchMedia&&W.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(still){clearHints();return;}
    host.style.setProperty("transition","opacity .2s ease-out, filter .2s ease-out","important");
    host.style.setProperty("opacity","0","important");
    host.style.setProperty("filter","blur(4px)","important");
    setTimeout(function(){if(H.host===host)clearHints();},220);
  }
  function goToHint(m){
    var smooth=!(W.matchMedia&&W.matchMedia("(prefers-reduced-motion: reduce)").matches);
    try{W.scrollTo({top:Math.max(0,m.y-W.innerHeight/3),left:Math.max(0,m.x-40),behavior:smooth?"smooth":"auto"});}catch(_){}
    m.box.classList.remove("pulse");void m.box.offsetWidth;m.box.classList.add("pulse");
  }
  function xButton(n,label){
    var x=document.createElement("button");
    x.type="button";x.className="x";x.textContent="×";
    x.title="Remove #"+n;x.setAttribute("aria-label","Remove mark "+n+": "+label);
    x.addEventListener("click",function(ev){
      if(!ev.isTrusted)return;
      ev.preventDefault();ev.stopPropagation();
      removeHint(n);
    });
    return x;
  }
  function renderDock(){
    if(!H.root)return;
    if(!H.dock){
      var dock=document.createElement("div");
      dock.className="dock";
      var bubble=document.createElement("button");
      bubble.type="button";bubble.className="bubble";
      var count=document.createElement("span");
      count.className="count";
      bubble.appendChild(bubbleIcon());bubble.appendChild(count);
      // A double click is the page's reset (user, 30.09: "double-click on
      // their bubble evaporates them"): all of them fade, and are gone.
      bubble.addEventListener("dblclick",function(ev){
        if(!ev.isTrusted)return;
        ev.preventDefault();ev.stopPropagation();
        evaporateHints();
      });
      var list=document.createElement("div");
      list.className="list";list.setAttribute("role","list");
      dock.appendChild(bubble);dock.appendChild(list);
      H.root.appendChild(dock);
      H.dock={node:dock,bubble:bubble,list:list};
    }
    var d=H.dock;
    d.bubble.querySelector(".count").textContent=String(H.marks.length);
    d.bubble.title=(H.marks.length===1?"1 mark on this page":H.marks.length+" marks on this page")+" \u2014 double-click to clear them";
    d.bubble.setAttribute("aria-label",d.bubble.title);
    d.list.textContent="";
    H.marks.forEach(function(m){
      var chip=document.createElement("div");
      chip.className="chip";chip.setAttribute("role","listitem");chip.tabIndex=0;
      chip.style.setProperty("--c",m.color);
      chip.title="#"+m.n+" "+m.note;
      var text=document.createElement("span");
      text.className="t";text.textContent="#"+m.n+" "+m.note;
      chip.appendChild(text);chip.appendChild(xButton(m.n,m.note));
      chip.addEventListener("click",function(ev){if(ev.isTrusted)goToHint(m);});
      chip.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();goToHint(m);}});
      d.list.appendChild(chip);
      m.chip=chip;
    });
  }
  /**
   * Replace the agent's marks with these, and answer what was drawn, in page
   * px. Each is {n, note, width, height, path?} with its place either in the
   * viewport (left, top: measured now) or on the page (x, y: kept from before);
   * the element its path finds, when there is one, is where it stays.
   */
  S.hints=function(list){
    clearHints();
    if(!Array.isArray(list)||!list.length)return [];
    ensureHints();
    for(var i=0;i<list.length&&i<6;i++){
      var h=list[i]||{};
      var n=Math.max(1,Math.floor(Number(h.n)||i+1));
      var paged=Number.isFinite(Number(h.x))&&Number.isFinite(Number(h.y))&&h.left===undefined;
      var x=Math.round(paged?Number(h.x):(Number(h.left)||0)+W.scrollX);
      var y=Math.round(paged?Number(h.y):(Number(h.top)||0)+W.scrollY);
      var w=Math.max(0,Math.round(Number(h.width)||0)),ht=Math.max(0,Math.round(Number(h.height)||0));
      var note=String(h.note||"").replace(/\s+/g," ").trim().slice(0,500);
      var path=typeof h.path==="string"&&h.path?h.path.slice(0,2000):undefined;
      var c=MARK_COLORS[(n-1)%MARK_COLORS.length];
      var delay=(i*90)+"ms";
      var box=document.createElement("div");
      box.className="box appear";
      box.style.left=x+"px";box.style.top=y+"px";
      box.style.width=w+"px";box.style.height=ht+"px";
      box.style.setProperty("--c",c[1]);box.style.setProperty("--d",delay);
      var node=document.createElement("div");
      node.className="mark hint appear";
      node.style.left=x+"px";node.style.top=y+"px";
      node.style.setProperty("--c",c[1]);node.style.setProperty("--d",delay);
      // From the outline's corner, up and to the right like the person's pin.
      var vx=x-W.scrollX,vy=y-W.scrollY;
      var angle=(vx>W.innerWidth-300?-3:-1)*Math.PI/4;
      if(vy<90)angle=-angle;
      var wrap=document.createElement("div");
      wrap.className="pinwrap";
      var pin=document.createElement("div");
      pin.className="pin";
      pin.style.background=c[1];
      pin.style.cursor="default";
      var num=document.createElement("span");
      num.textContent=String(n);
      pin.appendChild(num);
      wrap.appendChild(pin);
      var label=document.createElement("div");
      label.className="label";
      var words=document.createElement("span");
      words.textContent="#"+n+" "+note;
      label.appendChild(words);label.appendChild(xButton(n,note));
      node.appendChild(wrap);node.appendChild(label);
      H.root.appendChild(box);H.root.appendChild(node);
      var m={n:n,note:note,x:x,y:y,width:w,height:ht,path:path,el:null,color:c[1],box:box,node:node,chip:null,pin:pin,num:num,label:label,angle:angle};
      layoutMark(m);
      placeHint(m);
      H.marks.push(m);
    }
    renderDock();
    listenHints(true);
    hintsChanged();
    return H.marks.map(function(m){
      var kept={n:m.n,note:m.note,x:m.x,y:m.y,width:m.width,height:m.height};
      if(m.path)kept.path=m.path;
      return kept;
    });
  };
  S.clearHints=function(){clearHints();return true;};
  /** The marks still on the page, where they are now, once the person has put one away, or after ms. */
  S.hintsWait=function(ms){
    return new Promise(function(resolve){
      var done=false;
      function finish(state){
        if(done)return;
        done=true;clearTimeout(timer);
        var at=H.waiters.indexOf(finish);
        if(at>=0)H.waiters.splice(at,1);
        resolve(state);
      }
      H.waiters.push(finish);
      var timer=setTimeout(function(){finish(hintsState());},Math.max(50,Math.min(30000,Number(ms)||20000)));
    });
  };

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
