import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BookOpen, Check, Globe, Loader2, Puzzle, Search } from 'lucide-react';
import type { CatalogSearch, CatalogSkill, PluginCommand } from '../../shared/types';
import { api } from '../api';
import './SkillCommands.css';

// The composer's / menu (user, 29.09: "/findskills ca la dsh"). Every skill
// in one place — Hello's library, what the other agents on this Mac keep, and
// skills.sh when asked — picked by name. Picking one copies it into the
// library when it is not there, turns it on for this chat, and writes
// /skill:<name> at the start of the message: Pi puts that skill's
// instructions in front of what the person writes after it.

export const FIND_COMMAND = 'find-skills';
const MAX_ROWS = 60;

// The chat's plugin commands too (user, 30.09: "/sub… should offer /subagents").
// Only its running Pi can say which there are; what it last said is kept for
// this window, so they are offered after a restart before Pi runs again.
const COMMANDS_KEY = (conversationId: string) => `hello.commands.${conversationId}`;
function rememberedCommands(conversationId: string): PluginCommand[] {
  try {
    const saved = JSON.parse(localStorage.getItem(COMMANDS_KEY(conversationId)) ?? '[]') as unknown;
    return Array.isArray(saved) ? saved.filter((item): item is PluginCommand => Boolean(item) && typeof item === 'object'
      && typeof (item as PluginCommand).name === 'string' && typeof (item as PluginCommand).description === 'string') : [];
  } catch { return []; }
}
function rememberCommands(conversationId: string, commands: PluginCommand[]): void {
  try { localStorage.setItem(COMMANDS_KEY(conversationId), JSON.stringify(commands)); } catch { /* a convenience only */ }
}

/** What the draft asks of the menu: a skill by name, or a search for a task. */
export function slashIntent(draft: string): { kind: 'pick'; token: string } | { kind: 'find'; query: string } | null {
  const find = /^\/find-?skills(?:\s+([\s\S]*))?$/i.exec(draft);
  if (find && (find[1] !== undefined || /\s$/.test(draft))) return { kind: 'find', query: (find[1] ?? '').trim() };
  const pick = /^\/(\S*)$/.exec(draft);
  return pick ? { kind: 'pick', token: pick[1].replace(/^skill:/i, '').toLowerCase() } : null;
}

interface Row {
  id: string;
  label: string;
  detail: string;
  icon: typeof BookOpen;
  checked?: boolean;
  pending?: boolean;
  run(): void;
}

const installs = (count?: number) => count === undefined ? '' : count >= 1000 ? ` · ${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k installs` : ` · ${count} installs`;

export function useSkillCommands({ conversationId, draft, setDraft, focus, onError }: {
  conversationId: string;
  draft: string;
  setDraft(text: string): void;
  focus(): void;
  onError(reason: unknown): void;
}): { popup: ReactNode; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean; expanded: boolean; listId: string; activeId?: string } {
  // Optional while a renderer hot update runs against an older preload.
  const skills = (api as Partial<typeof api>).skills;
  const intent = skills ? slashIntent(draft) : null;
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [commands, setCommands] = useState<PluginCommand[]>([]);
  const [active, setActive] = useState<string[]>([]);
  const [found, setFound] = useState<{ query: string; result?: CatalogSearch; searching: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();
  const open = Boolean(intent) && dismissed !== draft;
  const loaded = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  // Escape closes the menu for that draft only.
  useEffect(() => { if (dismissed !== null && dismissed !== draft) setDismissed(null); }, [draft, dismissed]);

  const load = useCallback(() => {
    void skills?.list().then(setCatalog).catch(() => setCatalog([]));
    void api.extensions.active(conversationId).then(setActive).catch(() => setActive([]));
    setCommands(rememberedCommands(conversationId));
    const said = (api as Partial<typeof api>).chat?.commands?.(conversationId);
    void said?.then(list => {
      if (!list) return;
      rememberCommands(conversationId, list);
      setCommands(list);
    }).catch(() => undefined);
  }, [skills, conversationId]);
  // Read when the menu opens, and again when the library changes while it is open.
  useEffect(() => {
    if (!open) { loaded.current = false; return; }
    if (!loaded.current) { loaded.current = true; load(); }
    return api.extensions.onChange(load);
  }, [open, load]);
  useEffect(() => { setCatalog(null); setFound(null); setCommands([]); }, [conversationId]);

  const search = (query: string) => {
    if (!skills || !query) return;
    setFound({ query, searching: true });
    void skills.search(query, true)
      .then(result => setFound(current => current?.query === query ? { query, result, searching: false } : current))
      .catch(reason => { setFound(current => current?.query === query ? null : current); onError(reason); });
  };

  const use = (skill: CatalogSkill) => {
    if (!skills || pending) return;
    setPending(skill.id);
    void skills.use(skill.id, conversationId)
      .then(used => {
        setActive(current => current.includes(used.resourceId) ? current : [...current, used.resourceId]);
        setFound(null);
        // Copying from skills.sh takes a moment: words written meanwhile stay.
        const now = latest.current;
        if (slashIntent(now)) { setDraft(`/skill:${used.name} `); focus(); }
        else if (!now.startsWith('/skill:')) setDraft(`/skill:${used.name} ${now}`);
      })
      .catch(onError)
      .finally(() => setPending(null));
  };

  const skillRow = (skill: CatalogSkill): Row => ({
    id: skill.id,
    label: skill.name,
    detail: pending === skill.id
      ? (skill.origin === 'online' ? 'Copying from skills.sh…' : 'Turning on…')
      : `${skill.source}${installs(skill.installs)}${skill.description ? ` · ${skill.description}` : ''}`.slice(0, 140),
    icon: skill.origin === 'online' ? Globe : BookOpen,
    checked: skill.id.startsWith('library:') && active.includes(skill.id.slice('library:'.length)),
    pending: pending === skill.id,
    run: () => use(skill),
  });

  const listing = (): { rows: Row[]; note: string } => {
    if (!intent) return { rows: [], note: '' };
    if (intent.kind === 'find') {
      if (!intent.query) return { rows: [], note: 'Say what the task is — the search covers this Mac and skills.sh.' };
      if (found?.query !== intent.query) return {
        rows: [{ id: 'search', label: `Search for “${intent.query.slice(0, 80)}”`, detail: 'Hello’s library, the other agents on this Mac, and skills.sh', icon: Search, run: () => search(intent.query) }],
        note: '',
      };
      if (found.searching) return { rows: [], note: 'Searching this Mac and skills.sh…' };
      const result = found.result!;
      const rows = [...result.local, ...result.online].map(skillRow);
      return {
        rows,
        note: result.onlineError
          ? `skills.sh could not be reached: ${result.onlineError}`.slice(0, 160)
          : rows.length ? 'Online skills are other people’s instructions: read them before you rely on them.' : 'No skill fits that. Try other words.',
      };
    }
    const token = intent.token;
    const command: Row[] = FIND_COMMAND.startsWith(token.replace(/^\//, '')) || 'findskills'.startsWith(token)
      ? [{ id: 'command', label: `/${FIND_COMMAND}`, detail: 'Find a skill for a task — on this Mac and on skills.sh', icon: Search, run: () => setDraft(`/${FIND_COMMAND} `) }]
      : [];
    // A plugin's command, written with a space after it for what it takes.
    const pluginRows: Row[] = commands
      .filter(item => !token || item.name.toLowerCase().includes(token))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(token)) - Number(a.name.toLowerCase().startsWith(token)))
      .slice(0, 20)
      .map(item => ({
        id: `plugin:${item.name}`, label: `/${item.name}`, icon: Puzzle,
        detail: `Plugin command${item.description ? ` · ${item.description}` : ''}`.slice(0, 140),
        run: () => { setDraft(`/${item.name} `); focus(); },
      }));
    if (catalog === null) return { rows: [...command, ...pluginRows], note: 'Reading the skills on this Mac…' };
    const matching = catalog.filter(skill => !token || skill.name.toLowerCase().includes(token));
    matching.sort((a, b) => Number(b.name.toLowerCase().startsWith(token)) - Number(a.name.toLowerCase().startsWith(token)));
    const rows = [...command, ...pluginRows, ...matching.slice(0, MAX_ROWS).map(skillRow)];
    return {
      rows,
      note: matching.length > MAX_ROWS ? `${matching.length - MAX_ROWS} more — type more of the name` : '',
    };
  };
  const { rows, note } = listing();

  useEffect(() => { setIndex(0); }, [rows.length, intent?.kind]);
  const current = Math.min(index, Math.max(rows.length - 1, 0));
  const visible = open && (rows.length > 0 || Boolean(note));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!visible || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(draft); return true; }
    // A search command is never a message, even while it has nothing to pick.
    if (!rows.length && intent?.kind === 'find' && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); return true; }
    if (!rows.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      rows[current]?.run();
      return true;
    }
    return false;
  };

  const popup = visible ? (
    <div className="skill-commands">
      {rows.length > 0 && <div role="listbox" id={listId} aria-label="Commands and skills">
        {rows.map((row, position) => (
          <div
            key={row.id}
            id={`${listId}-${position}`}
            role="option"
            aria-selected={position === current}
            aria-disabled={row.pending || undefined}
            className="skill-commands__row"
            data-active={position === current}
            onPointerMove={() => setIndex(position)}
            // The textarea keeps focus: the menu is read with the caret still in the message.
            onPointerDown={event => event.preventDefault()}
            onClick={() => row.run()}
          >
            {row.pending ? <Loader2 size={16} className="browser-spinner" aria-hidden /> : <row.icon size={16} aria-hidden />}
            <span className="menu-item-copy"><span className="truncate">{row.label}</span><small>{row.detail}</small></span>
            {row.checked && <Check size={14} aria-label="On in this chat" />}
          </div>
        ))}
      </div>}
      {note && <p className="skill-commands__note" role="status">{note}</p>}
    </div>
  ) : null;
  return { popup, onKeyDown, expanded: visible && rows.length > 0, listId, activeId: visible && rows.length ? `${listId}-${current}` : undefined };
}
