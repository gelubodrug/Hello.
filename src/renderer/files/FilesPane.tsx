import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import { CaseSensitive, Check, ChevronDown, ChevronRight, Copy, File, FileText, Folder, FolderOpen, MessageSquareQuote, PanelRight, RefreshCw, Search } from 'lucide-react';
import type { ChatQuoteExtra, Conversation } from '../../shared/types';
import { fileLanguage, type ContentSearch, type FileDocument, type FileEntry, type FileLink, type FileListing } from '../../shared/files';
import { api } from '../api';
import { CodeBlock, Markdown } from '../chat/Markdown';
import { ContextMenu, ErrorNote, IconButton, MenuButton, Truncated, errorText } from '../ui/primitives';
import { FileTypeIcon } from './FileTypeIcon';
import { ContentResults, contentNotice } from './ContentResults';
import { QUOTE_LIMIT, fileSelection, hasSelectionIn, selectionQuote, type FileSelection } from './selection';
import { setInternalFileDrop } from '../drop';
import { captureFileView, restoreFileView, type FileViewState } from './view-state';
import './files.css';

type TreeEntry = FileEntry & { children?: TreeEntry[] };
export type FileRequest = FileLink & { nonce: number };
const FileDragConversation = createContext('');

function hierarchy(entries: FileEntry[]): TreeEntry[] {
  const nodes = new Map(entries.map(entry => [entry.path, { ...entry, ...(entry.kind === 'directory' ? { children: [] as TreeEntry[] } : {}) }]));
  const roots: TreeEntry[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.path.slice(0, node.path.lastIndexOf('/')));
    if (node.path.includes('/') && parent?.children) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: TreeEntry[]) => { items.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true })); items.forEach(item => item.children && sort(item.children)); };
  sort(roots);
  return roots;
}

function FileNode({ node, style }: NodeRendererProps<TreeEntry>) {
  const conversationId = useContext(FileDragConversation);
  const folder = node.data.kind === 'directory';
  const FolderIcon = node.isOpen ? FolderOpen : Folder;
  return <div className="files-tree-node" style={style} data-selected={node.isSelected} title={node.data.path}
    draggable={Boolean(conversationId)} onDragStart={event => {
      if (!conversationId) { event.preventDefault(); return; }
      event.stopPropagation();
      setInternalFileDrop(event.dataTransfer, conversationId, [node.data.path]);
    }}>
    {folder ? <button type="button" tabIndex={-1} className="files-folder-toggle" aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${node.data.name}`}
      onClick={event => { event.stopPropagation(); node.toggle(); }}>{node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      : <span className="files-folder-spacer" />}
    {folder ? <FolderIcon size={16} aria-hidden="true" /> : <FileTypeIcon name={node.data.name} linked={node.data.kind === 'link'} />}
    <span className="files-tree-name">{node.data.name}</span>
  </div>;
}

export function FilesPane({ conversation, visible, request, onChooseFolder, onQuote }: {
  conversation: Conversation; visible: boolean; request: FileRequest | null; onChooseFolder: () => void;
  /** Adds words to this chat's draft and shows Chat; never sends them. */
  onQuote?: (text: string, extra?: ChatQuoteExtra) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const treeBox = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const tree = useRef<TreeApi<TreeEntry>>(null);
  const directories = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [listed, setListed] = useState(false);
  const [listingBusy, setListingBusy] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileListing | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [listNotice, setListNotice] = useState('');
  const [document, setDocument] = useState<FileDocument | null>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const preservedView = useRef<{ file: FileDocument; state: FileViewState } | null>(null);
  const [location, setLocation] = useState<FileLink | null>(null);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [reading, setReading] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [mobileReading, setMobileReading] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [treeSize, setTreeSize] = useState({ width: 240, height: 1 });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Names filters the tree; Contents searches inside the files (audit A3b).
  const [scope, setScope] = useState<'names' | 'contents'>('names');
  const [matchCase, setMatchCase] = useState(false);
  const [found, setFound] = useState<ContentSearch | null>(null);
  const [scanning, setScanning] = useState(false);
  const searchSequence = useRef(0);
  const [selecting, setSelecting] = useState(false);
  const [menu, setMenu] = useState<{ position: { x: number; y: number }; selected: FileSelection | null; file: FileDocument } | null>(null);
  const contents = scope === 'contents' && Boolean(api.files.searchContents);
  const names = contents ? '' : query;
  const contentQuery = contents && query.trim().length >= 2 ? query : '';
  const requestHandled = useRef<number>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readSequence.current++; }; }, []);
  useLayoutEffect(() => {
    if (!root.current || !treeBox.current) return;
    const measure = () => {
      const bounds = root.current!.getBoundingClientRect(), treeBounds = treeBox.current!.getBoundingClientRect();
      if (bounds.width) setNarrow(bounds.width < 600);
      if (treeBounds.width && treeBounds.height) setTreeSize({ width: Math.floor(treeBounds.width), height: Math.floor(treeBounds.height) });
    };
    const observer = new ResizeObserver(measure); observer.observe(root.current); observer.observe(treeBox.current); measure();
    return () => observer.disconnect();
  }, [conversation.folder]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);

  const loadDirectory = useCallback((path: string): Promise<void> => {
    const existing = directories.current.get(path);
    if (existing) return existing;
    setListingBusy(count => count + 1);
    const operation = api.files.list(conversation.id, path).then(list => {
      if (!mounted.current) return;
      setEntries(current => {
        const next = new Map(current.map(entry => [entry.path, entry]));
        for (const entry of list.entries) next.set(entry.path, entry);
        return [...next.values()];
      });
      if (!path) setListed(true);
      if (list.limited) setListNotice('Only the first 10,000 entries or 4 seconds of listing are shown. Browse a smaller folder.');
    }).catch(reason => {
      directories.current.delete(path);
      if (mounted.current) setError(errorText(reason));
    }).finally(() => { if (mounted.current) setListingBusy(count => count - 1); });
    directories.current.set(path, operation);
    return operation;
  }, [conversation.id]);

  useEffect(() => {
    if (visible && conversation.folder && !listed) void loadDirectory('');
  }, [visible, conversation.folder, listed, loadDirectory]);

  useEffect(() => {
    if (!names.trim() || !visible || !conversation.folder) { setResults(null); setSearching(false); return; }
    let current = true;
    setSearching(true); setResults(null);
    const timer = setTimeout(() => {
      void api.files.list(conversation.id, '', names).then(list => { if (current) setResults(list); })
        .catch(reason => { if (current) setError(errorText(reason)); })
        .finally(() => { if (current) setSearching(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [conversation.id, conversation.folder, names, visible, refreshEpoch]);
  useEffect(() => {
    const search = api.files.searchContents;
    if (!contentQuery || !visible || !conversation.folder || !search) { setFound(null); setScanning(false); return; }
    let current = true;
    const requestId = String(++searchSequence.current);
    setScanning(true); setFound(null);
    const timer = setTimeout(() => {
      void search(conversation.id, requestId, contentQuery, { matchCase })
        .then(result => { if (current && result.requestId === requestId) setFound(result); })
        .catch(reason => { if (current) setError(errorText(reason)); })
        .finally(() => { if (current) setScanning(false); });
    }, 250);
    return () => {
      current = false; clearTimeout(timer);
      // Typing on, hiding Files, leaving Contents or the folder: the older scan stops in main too.
      void api.files.cancelSearch?.(conversation.id)?.catch(() => undefined);
    };
  }, [conversation.id, conversation.folder, contentQuery, matchCase, visible, refreshEpoch]);

  const readFile = useCallback(async (target: FileLink, refresh = false) => {
    const sequence = ++readSequence.current;
    setError(null); setCopied(false); setLocation(target);
    if (target.line) setMode('source');
    else if (!refresh) setMode('preview');
    setMobileReading(true);
    if (!refresh && documentRef.current?.path === target.path) { setReading(false); return; }
    setReading(true); setDocument(null);
    try {
      const file = await api.files.read(conversation.id, target.path);
      if (!mounted.current || sequence !== readSequence.current) return;
      setDocument(file); setLocation({ ...target, path: file.path }); setReading(false);
      // Hydrate ancestors for references opened directly from chat/Markdown.
      await loadDirectory('');
      const parents = file.path.split('/'); parents.pop();
      for (let index = 1; index <= parents.length; index++) {
        if (!mounted.current || sequence !== readSequence.current) return;
        await loadDirectory(parents.slice(0, index).join('/'));
      }
    } catch (reason) { if (mounted.current && sequence === readSequence.current) setError(errorText(reason)); }
    finally { if (mounted.current && sequence === readSequence.current) setReading(false); }
  }, [conversation.id, loadDirectory]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = true;
    const unsubscribe = api.files.onChange?.(event => {
      if (event.conversationId !== conversation.id || event.folder !== conversation.folder ||
          !['file_edit', 'file_write'].includes(event.source) || event.path !== documentRef.current?.path) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const before = documentRef.current;
        if (!before || before.path !== event.path) return;
        const sequence = ++readSequence.current;
        void api.files.read(conversation.id, before.path).then(file => {
          if (!current || !mounted.current || sequence !== readSequence.current || documentRef.current?.path !== before.path) return;
          // Capture at completion, including any scroll/selection made while reading.
          if (viewport.current) preservedView.current = { file, state: captureFileView(viewport.current) };
          setDocument(file);
        }).catch(reason => { if (current && mounted.current && sequence === readSequence.current) setError(errorText(reason)); });
      }, 75);
    });
    return () => { current = false; clearTimeout(timer); unsubscribe?.(); };
  }, [conversation.id, conversation.folder]);
  useEffect(() => {
    if (!request || requestHandled.current === request.nonce || !conversation.folder) return;
    requestHandled.current = request.nonce;
    setQuery('');
    void readFile(request);
  }, [request, conversation.folder, readFile]);

  const data = useMemo(() => hierarchy(names.trim() ? results?.entries ?? [] : entries), [entries, results, names]);
  useEffect(() => {
    if (!document || !tree.current) return;
    tree.current.openParents(document.path);
    const selected = tree.current.get(document.path);
    if (selected && !selected.isSelected) tree.current.select(selected, { focus: false });
  }, [document?.path, data]);
  const markdown = !!document && /\.(?:md|markdown|mdx)$/i.test(document.name);
  const preview = markdown && mode === 'preview' && (document?.content?.length ?? 0) <= 200_000;
  // Whether words are selected in the viewer, for "Add selection to chat".
  useEffect(() => {
    const area = viewport.current;
    if (!area) return;
    const changed = () => setSelecting(hasSelectionIn(area));
    changed();
    area.ownerDocument.addEventListener('selectionchange', changed);
    return () => area.ownerDocument.removeEventListener('selectionchange', changed);
  }, [conversation.folder, document, preview]);
  useEffect(() => {
    if (!document || !viewport.current) return;
    const area = viewport.current;
    const preserved = preservedView.current;
    if (preserved?.file === document) {
      const restore = () => restoreFileView(area, preserved.state);
      restore();
      // Shiki can replace plain text later. Reapply the same view until the
      // person interacts; these DOM changes never trigger another file read.
      const observer = new MutationObserver(restore);
      observer.observe(area, { childList: true, subtree: true });
      const release = () => { observer.disconnect(); preservedView.current = null; };
      const actions = ['pointerdown', 'keydown', 'wheel'] as const;
      actions.forEach(name => area.ownerDocument.addEventListener(name, release, { once: true, capture: true }));
      return () => { observer.disconnect(); actions.forEach(name => area.ownerDocument.removeEventListener(name, release, true)); };
    }
    const selector = location?.line ? `[data-line="${location.line}"]` : location?.anchor ? `#${CSS.escape(`file-heading-${location.anchor}`)}` : null;
    const reveal = () => {
      const target = selector ? area.querySelector<HTMLElement>(selector) : null;
      if (target) area.scrollTop = target.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 16;
      else if (!selector) area.scrollTop = 0;
    };
    reveal();
    // Shiki completes asynchronously; keep source line navigation accurate.
    const observer = new MutationObserver(reveal); observer.observe(area, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [document, location, preview]);

  const act = async (action: () => Promise<unknown>) => { setError(null); try { await action(); } catch (reason) { setError(errorText(reason)); } };
  const refresh = async () => {
    directories.current.clear(); setEntries([]); setListNotice(''); setError(null);
    setRefreshEpoch(value => value + 1);
    await loadDirectory('');
    if (documentRef.current) await readFile({ path: documentRef.current.path }, true);
  };
  const copy = () => act(async () => { if (document?.content == null) return; await api.system.copy({ text: document.content }); setCopied(true); });
  const external = () => act(async () => {
    if (!document) return;
    try { await api.files.open(conversation.id, document.path); } finally { }
  });
  /** The selection, taken before the button or the menu had focus, into this chat's draft. */
  const quote = (selected: FileSelection | null, file: FileDocument | null) => {
    if (!onQuote) return;
    setError(null);
    if (!selected || !file) { setError('Select some text in the file first.'); return; }
    if (file !== documentRef.current) { setError('The file changed after the text was selected. Select it again.'); return; }
    if (selected.text.length > QUOTE_LIMIT) {
      setError(`The selection has ${selected.text.length.toLocaleString('en-US')} characters; up to ${QUOTE_LIMIT.toLocaleString('en-US')} can be added to the chat. Select less, or attach the file instead.`);
      return;
    }
    onQuote(selectionQuote(selected, fileLanguage(file.name)), { verbatim: true });
  };
  const treeVisible = (showTree && (!narrow || !mobileReading)) || (!document && !reading);

  return <div className="files-pane" ref={root} data-narrow={narrow} data-tree-visible={treeVisible}>
    <div className="files-toolbar">
      <div className="files-breadcrumb" title={document?.absolutePath ?? conversation.folder ?? 'Files'}>
        {document ? <FileTypeIcon name={document.name} /> : <FileText size={15} />}<Truncated>{document?.path ?? location?.path ?? 'Files'}</Truncated>
      </div>
      {document?.content != null && <>
        {markdown && <div className="files-modes" role="group" aria-label="File view">
          <button className="text-button" aria-pressed={preview} disabled={document.content.length > 200_000} onClick={() => setMode('preview')}>Preview</button>
          <button className="text-button" aria-pressed={!preview} onClick={() => setMode('source')}>Source</button>
        </div>}
        {onQuote && <IconButton label="Add selection to chat" disabled={!selecting}
          // The words stay selected while the button is pressed.
          onMouseDown={event => event.preventDefault()}
          onClick={() => quote(viewport.current && fileSelection(viewport.current, document, !preview), document)}><MessageSquareQuote size={15} /></IconButton>}
        <IconButton label={copied ? 'File copied' : 'Copy file content'} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
      </>}
      {document && <MenuButton label="Open file options" className="pill" items={[
        { id: 'open', label: 'Open in default app', icon: File, action: () => void external() },
        { id: 'reveal', label: 'Show in Finder', icon: FolderOpen, action: () => void act(() => api.files.reveal(conversation.id, document.path)) },
        { id: 'path', label: 'Copy path', icon: Copy, action: () => void act(() => api.system.copy({ text: document.absolutePath })) },
      ]}>Open <ChevronDown size={13} /></MenuButton>}
      <IconButton label={treeVisible ? 'Hide file tree' : 'Show file tree'} disabled={!conversation.folder || (!document && !reading)} onClick={() => { if (narrow) { setShowTree(true); setMobileReading(treeVisible); } else setShowTree(!treeVisible); }}><PanelRight size={15} /></IconButton>
    </div>
    <ErrorNote error={error} />
    {!conversation.folder ? <div className="files-empty"><FolderOpen size={28} /><h2>Files from this conversation</h2><p>Choose a working folder to browse documents and source code. Files stay on your computer.</p><button className="pill" onClick={onChooseFolder}>Choose folder</button></div>
      : <div className="files-body">
        <div className="files-document" ref={viewport} aria-label="File contents" aria-busy={reading} tabIndex={0}
          onContextMenu={event => {
            if (!document || document.content == null || reading) return;
            event.preventDefault();
            // Taken now, before the menu has focus.
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ position: { x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + 16 }, selected: fileSelection(event.currentTarget, document, !preview), file: document });
          }}>
          {reading ? <div className="files-empty" role="status">Reading file…</div>
            : document ? document.content == null ? <div className="files-empty"><File size={28} /><h2>{document.name}</h2><p>{document.reason}</p><button className="pill" onClick={() => void external()}>Open in default app</button></div>
              : <>{markdown && document.content.length > 200_000 && <p className="files-notice">Large Markdown document — showing source to keep the viewer responsive.</p>}
                {preview ? <Markdown text={document.content} filePath={document.path} onOpenFile={target => { setQuery(''); void readFile(target); }} />
                  : <CodeBlock code={document.content} language={fileLanguage(document.name)} lineNumbers />}</>
              : <div className="files-empty"><FileText size={28} /><h2>Choose a file</h2><p>Preview Markdown or read highlighted source. File links in chat open here too.</p></div>}
        </div>
        <aside className="files-tree" aria-label="Conversation files">
          <div className="files-root"><Folder size={16} /><Truncated title={conversation.folder}>{conversation.folder.replace(/\/$/, '').split('/').pop() || conversation.folder}</Truncated>
            <IconButton label="Refresh files and document" disabled={!!listingBusy || reading || searching || scanning} onClick={() => void refresh()}><RefreshCw size={14} /></IconButton></div>
          {api.files.searchContents && <div className="files-modes files-scope" role="group" aria-label="Search files by">
            <button className="text-button" aria-pressed={!contents} onClick={() => setScope('names')}>Names</button>
            <button className="text-button" aria-pressed={contents} onClick={() => setScope('contents')}>Contents</button>
          </div>}
          <label className="files-filter"><Search size={15} />
            <input aria-label={contents ? 'Search file contents' : 'Filter files'} placeholder={contents ? 'Search in files…' : 'Filter files…'} maxLength={300} value={query} onChange={event => setQuery(event.target.value)} />
            {contents && <button type="button" className="files-case" aria-pressed={matchCase} aria-label="Match case" title="Match case" onClick={() => setMatchCase(value => !value)}><CaseSensitive size={15} /></button>}
          </label>
          {contentQuery && <ContentResults found={found} scanning={scanning} onOpen={match => void readFile({ path: match.path, line: match.line })} />}
          <div className="files-tree-box" ref={treeBox} aria-busy={!!listingBusy || searching} hidden={Boolean(contentQuery)}
            onKeyDownCapture={event => {
              if (event.key === 'Enter' && tree.current?.focusedNode) {
                event.preventDefault(); event.stopPropagation(); tree.current.focusedNode.activate();
              }
            }}>
            <FileDragConversation.Provider value={conversation.id}><Tree<TreeEntry> ref={tree} data={data} idAccessor="path" width={treeSize.width} height={treeSize.height} rowHeight={32} indent={16} overscanCount={8}
              aria-label="Files in conversation folder" openByDefault={false} disableEdit disableDrag disableDrop disableMultiSelection
              searchTerm={names} searchMatch={(node, term) => node.data.path.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())}
              onToggle={path => { if (!names.trim()) void loadDirectory(path); }}
              onActivate={node => { if (node.isInternal) node.toggle(); else void readFile({ path: node.id }); }}
              selection={document?.path}>{FileNode}</Tree></FileDragConversation.Provider>
            {!data.length && <p className="files-tree-empty" role="status">{searching ? 'Filtering files…' : listingBusy ? 'Loading files…' : names ? 'No matching files.' : listed ? 'This folder is empty.' : 'Use Refresh to load files.'}</p>}
          </div>
          {(contents || names.trim() || listNotice) && <p className="files-notice">{contents ? contentNotice(found, query) : names.trim() ? `${results?.limited ? 'Partial results. ' : ''}Filters names and paths; skips dependency, build and .git folders.${results?.skipped ? ` ${results.skipped} folders skipped.` : ''}` : listNotice}</p>}
        </aside>
      </div>}
    <ContextMenu position={menu?.position ?? null} ariaLabel="File text actions"
      items={menu ? [
        ...(onQuote ? [{ id: 'quote', label: 'Add selection to chat', icon: MessageSquareQuote, disabled: !menu.selected, action: () => quote(menu.selected, menu.file) }] : []),
        { id: 'copy', label: 'Copy', icon: Copy, shortcut: '⌘ C', disabled: !menu.selected, action: () => void act(() => api.system.copy({ text: menu.selected?.text ?? '' })) },
      ] : []}
      onClose={reason => {
        // Back to the file after Escape, or after an action that left focus in the menu.
        if (reason === 'escape' || (reason === 'action' && viewport.current?.ownerDocument.activeElement?.closest('.menu-popup')))
          viewport.current?.focus({ preventScroll: true });
        setMenu(null);
      }} />
  </div>;
}
