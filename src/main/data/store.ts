import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import type { GateState } from '../chat/gate';
import { fetchedSources, sourcesForMessage, withSourceLinks } from '../../shared/web';
import type {
  AppSettings,
  VoiceSettings,
  UsageSummary,
  SavedConnection,
  LibraryResource,
  ResourceKind,
  BrowserDownload,
  BrowserTab,
  ChatModel,
  Conversation,
  Message,
  MessageMatch,
  NotebookEntry,
  NotebookChange,
  NotebookKind,
  NotebookPaths,
  QueuedMessage,
  QueuedMode,
  SettingsPatch,
  TabMark,
  TabMarks,
} from '../../shared/types';

export interface SecretCodec {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export type NotebookInput = Pick<
  NotebookEntry,
  'conversationId' | 'kind' | 'title' | 'body'
> & { id?: string; expectedUpdatedAt?: number };

/** Persisted shape: a remembered connection never stores whether a key exists — that is read from the secrets table. */
type StoredConnection = Omit<SavedConnection, 'apiKeySet'>;
type StoredSettings = Omit<AppSettings, 'apiKeySet' | 'connections'> & { connections: StoredConnection[] };
const CONNECTION_LIMIT = 12;

/** Voice as stored: a speech server is on this Mac or nowhere, and a voice id is a short name. */
function voiceSettings(value: Partial<VoiceSettings>): VoiceSettings {
  const text = (field: unknown, limit: number) => typeof field === 'string' ? field.trim().slice(0, limit) : '';
  const sttEndpointUrl = text(value.sttEndpointUrl, 500);
  const sttModel = text(value.sttModel, 500);
  const sourceLanguage = text(value.sourceLanguage, 10).toLowerCase();
  const ttsEndpointUrl = text(value.ttsEndpointUrl, 500);
  const ttsVoice = text(value.ttsVoice, 100);
  for (const url of [sttEndpointUrl, ttsEndpointUrl])
    if (url && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) throw new Error('A voice server runs on this Mac: http://localhost:<port>.');
  if (sourceLanguage && !/^[a-z]{2,3}$/.test(sourceLanguage)) throw new Error('A language is a short code, like ro or en.');
  if (ttsVoice && !/^[\w.+-]+$/.test(ttsVoice)) throw new Error('A voice is a name like af_heart.');
  return {
    enabled: value.enabled === true,
    ...(value.autoSend === true ? { autoSend: true } : {}),
    ...(sttEndpointUrl ? { sttEndpointUrl } : {}),
    ...(sttModel ? { sttModel } : {}),
    ...(sourceLanguage ? { sourceLanguage } : {}),
    ...(ttsEndpointUrl ? { ttsEndpointUrl } : {}),
    ...(ttsVoice ? { ttsVoice } : {}),
  };
}

/**
 * What the window asked Voice to become, checked: switches are booleans and
 * fields short strings, and only what was given is passed on — the rest stays
 * as stored. A switch turned off is passed on as false, never left out: left
 * out, the merge below would keep the old on (user, 09.10: Auto Send stuck).
 */
export function voicePatch(value: unknown, current: VoiceSettings | undefined): VoiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  const voice = value as Record<string, unknown>;
  for (const key of ['enabled', 'autoSend'] as const)
    if (voice[key] !== undefined && typeof voice[key] !== 'boolean') throw new Error('Invalid voice setting.');
  const fields = ['sttEndpointUrl', 'sttModel', 'sourceLanguage', 'ttsEndpointUrl', 'ttsVoice'] as const;
  for (const key of fields)
    if (voice[key] !== undefined && (typeof voice[key] !== 'string' || (voice[key] as string).length > 500)) throw new Error('Invalid voice setting.');
  const patch: VoiceSettings = { enabled: voice.enabled === undefined ? current?.enabled === true : voice.enabled === true };
  if (voice.autoSend !== undefined) patch.autoSend = voice.autoSend === true;
  for (const key of fields) if (voice[key] !== undefined) patch[key] = voice[key] as string;
  return patch;
}

/** A model and a voice belong to the server that offered them: pointing at another drops them, unless given anew. */
function nextVoice(current: VoiceSettings | undefined, patch: Partial<VoiceSettings>): VoiceSettings {
  const next: Partial<VoiceSettings> = { ...current, ...patch };
  if (patch.sttEndpointUrl !== undefined && patch.sttModel === undefined && (patch.sttEndpointUrl.trim() || undefined) !== current?.sttEndpointUrl) delete next.sttModel;
  if (patch.ttsEndpointUrl !== undefined && patch.ttsVoice === undefined && (patch.ttsEndpointUrl.trim() || undefined) !== current?.ttsEndpointUrl) delete next.ttsVoice;
  return voiceSettings(next);
}

const DEFAULT_SETTINGS: StoredSettings = {
  endpointUrl: 'http://127.0.0.1:1234/v1',
  model: '',
  systemPrompt:
    'You are a helpful assistant. Be accurate and concise. Use available tools when needed; never claim a tool action succeeded without its result.',
  temperature: 0.7,
  reasoningEffort: 'off',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  modelCompatibility: 'auto',
  approvals: 'all',
  connections: [],
  appearance: 'system',
};

const strip = ({ apiKeySet: _apiKeySet, ...entry }: SavedConnection): StoredConnection => entry;

/** Which endpoint and model a stored context/output pair was resolved for. */
export const limitsKey = (endpointUrl: string, model: string): string =>
  `${normalizeEndpoint(endpointUrl)}\u0000${model.trim()}`;

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS model endpoint.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'The endpoint must use HTTP or HTTPS without embedded credentials, query or fragment.',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/** The words around the first place the term occurs, on one line. */
export function snippetAround(content: string, term: string, before = 40, after = 90): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const at = flat.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (at < 0) return flat.slice(0, before + after) + (flat.length > before + after ? '…' : '');
  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + term.length + after);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
function title(value: string, fallback: string): string {
  const result = value.trim().slice(0, 250);
  return result || fallback;
}
/** A chat's model as it is kept: the endpoint its key is filed under, and the model's id. */
function chatModel(value: ChatModel): ChatModel {
  const id = typeof value?.id === 'string' ? value.id.trim().slice(0, 500) : '';
  if (!id) throw new Error('Choose a model for this chat.');
  return { endpointUrl: normalizeEndpoint(value.endpointUrl), id };
}
/** A chat's switches live in `settings`, keyed by chat: which notebook
 *  sections are on, and the model it runs on. Absent means the default —
 *  every section off (user, 05.10), the selection in Settings. A chat has no
 *  mode (user, 17.11): a `chat-mode:` row an older version wrote is read by
 *  nothing, and goes with its chat. Only the departure from the default is stored; a chat made while
 *  Runbook and Tasks started on had them written down for it (version 15). */
/** The Workbook (the chat's page of Runbooks, Tasks and Plans) is a switch of its own, off by default (user,
 *  17.11), stored like the others: only when on. While it is off the sections read as off, whatever is stored
 *  for them — so switching it back on finds them as they were. A chat that used the page before the switch
 *  existed had it written down as on (version 17). */
const CONVERSATION_COLUMNS = `SELECT c.*,
    CASE WHEN w.value = 'on' THEN 1 ELSE 0 END AS notebook,
    CASE WHEN p.value = 'on' THEN 1 ELSE 0 END AS planning,
    CASE WHEN r.value = 'on' THEN 1 ELSE 0 END AS runbook,
    CASE WHEN t.value = 'on' THEN 1 ELSE 0 END AS tasks,
    a.value AS askFirst,
    CAST(f.value AS INTEGER) AS freshFrom,
    json_extract(cm.value, '$.endpointUrl') AS modelEndpoint,
    json_extract(cm.value, '$.id') AS modelId
  FROM conversations c
  LEFT JOIN settings w ON w.key = 'chat-notebook:' || c.id
  LEFT JOIN settings p ON p.key = 'chat-plan:' || c.id
  LEFT JOIN settings r ON r.key = 'chat-runbook:' || c.id
  LEFT JOIN settings t ON t.key = 'chat-tasks:' || c.id
  LEFT JOIN settings a ON a.key = 'chat-ask-first:' || c.id
  LEFT JOIN settings f ON f.key = 'chat-fresh:' || c.id
  LEFT JOIN settings cm ON cm.key = 'chat-model:' || c.id`;
type StoredConversation = Omit<Conversation, 'notebook' | 'planning' | 'runbook' | 'tasks' | 'askFirst' | 'freshFrom' | 'model'>
  & { notebook: number; planning: number; runbook: number; tasks: number; askFirst: string | null; freshFrom: number | null; modelEndpoint: string | null; modelId: string | null };
// Ask first is the one switch with a default that depends on the chat's connection (on for a server of the
// person's own), so both choices are written down; absent is the default, decided where the connection is known.
const hydrateConversation = ({ askFirst, freshFrom, modelEndpoint, modelId, ...row }: StoredConversation): Conversation =>
  ({ ...row, notebook: row.notebook === 1,
    planning: row.notebook === 1 && row.planning === 1, runbook: row.notebook === 1 && row.runbook === 1, tasks: row.notebook === 1 && row.tasks === 1,
    ...(askFirst === 'on' ? { askFirst: true } : askFirst === 'off' ? { askFirst: false } : {}),
    ...(typeof freshFrom === 'number' && freshFrom > 0 ? { freshFrom } : {}),
    ...(typeof modelEndpoint === 'string' && typeof modelId === 'string' && modelId ? { model: { endpointUrl: modelEndpoint, id: modelId } } : {}) });
export const NOTEBOOK_KINDS: readonly NotebookKind[] = ['runbook', 'tasks', 'plan'];
function validKind(kind: string): asserts kind is NotebookKind {
  if (!(NOTEBOOK_KINDS as readonly string[]).includes(kind))
    throw new Error('Unknown notebook kind.');
}
type StoredNotebook = Omit<NotebookEntry, 'shared'> & { shared: number };
const hydrateNotebook = ({ shared, ...row }: StoredNotebook): NotebookEntry => ({ ...row, shared: shared !== 0 });
function parse<T>(json: unknown, fallback: T): T {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
}

export interface ResourceRow {
  id: string; kind: ResourceKind; name: string; description: string;
  source: string; version: string; fingerprint: string; config: string;
  createdAt: number; updatedAt: number;
}

/** New app-owned SQLite database; no discovery or access to another app's files. */
export class DataStore {
  readonly dataDir: string;
  readonly databasePath: string;
  private readonly db: Database.Database;
  private readonly codec: SecretCodec;
  private readonly notebookListeners = new Set<(change: NotebookChange) => void>();

  constructor(dataDir: string, codec: SecretCodec) {
    this.dataDir = path.resolve(dataDir);
    this.databasePath = path.join(this.dataDir, 'hello.sqlite');
    this.codec = codec;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.migrate();
    // A terminated process must not leave an apparently active response/approval.
    const interrupted = this.db
      .prepare("SELECT id,parts FROM messages WHERE status = 'streaming'")
      .all() as Array<{ id: string; parts: string }>;
    this.db.transaction(() => {
      for (const row of interrupted) {
        const parts =
          parse<Message['parts']>(row.parts, [])?.map((part) =>
            part.type === 'tool' &&
            ['running', 'approval'].includes(part.status)
              ? {
                  ...part,
                  status: 'error' as const,
                  approvalId: undefined,
                  output:
                    'Action was interrupted when the application closed; it has not been resumed.',
                }
              : part,
          ) ?? [];
        this.db
          .prepare(
            "UPDATE messages SET status = 'error', error = 'Response interrupted when the application closed.', parts = ? WHERE id = ?",
          )
          .run(JSON.stringify(parts), row.id);
      }
    })();
    // A file still saving when the app closed was not saved: the process that
    // wrote it is gone, and the list must not say "saving" forever.
    this.db
      .prepare("UPDATE browser_downloads SET state = 'failed', reason = 'interrupted when the application closed', finishedAt = ? WHERE state = 'saving'")
      .run(Date.now());
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(this.databasePath + suffix))
        chmodSync(this.databasePath + suffix, 0o600);
    }
  }

  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 18)
      throw new Error('This database belongs to a newer Hello. version.');
    if (version < 1)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, folder TEXT,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE TABLE messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL CHECK(status IN ('complete','streaming','error')),
          createdAt INTEGER NOT NULL, error TEXT, usage TEXT
        );
        CREATE INDEX messages_conversation ON messages(conversationId, seq);
        CREATE TABLE notebooks (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('runbook','tasks')),
          title TEXT NOT NULL, body TEXT NOT NULL,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE INDEX notebooks_conversation ON notebooks(conversationId, kind, createdAt);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE secrets (key TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
        PRAGMA user_version = 1;
      `);
      })();
    if (version < 2)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE browser_tabs (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT NOT NULL, url TEXT NOT NULL
      ); PRAGMA user_version = 2;`);
      })();
    if (version < 3)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('skill','plugin','mcp')),
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX resources_identity ON resources(kind, name);
      CREATE TABLE resource_activations (
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        resourceId TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        PRIMARY KEY (conversationId, resourceId)
      );
      PRAGMA user_version = 3;`);
      })();
    if (version < 4)
      this.db.transaction(() => {
        // What the person said while the model was still working. It is not part
        // of the conversation until it is delivered, so it lives on its own and
        // survives a restart: their words are not ours to lose.
        this.db.exec(`CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('steer','next','later')),
        position INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX queued_conversation ON queued_messages(conversationId, position);
      PRAGMA user_version = 4;`);
      })();
    if (version < 5)
      this.db.transaction(() => {
        // The grant the human set on a page comes back with the page (user,
        // 22.09). Every tab saved before this column existed reads as Off.
        this.db.exec(`ALTER TABLE browser_tabs ADD COLUMN control TEXT NOT NULL DEFAULT 'off';
      PRAGMA user_version = 5;`);
      })();
    if (version < 6)
      this.db.transaction(() => {
        // A chat's downloads, kept between sessions like a browser keeps its
        // list (user, 24.09): what was saved, where, from which page.
        this.db.exec(`CREATE TABLE browser_downloads (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tabId TEXT, name TEXT NOT NULL, path TEXT, url TEXT, mimeType TEXT,
        state TEXT NOT NULL CHECK(state IN ('saving','saved','failed','cancelled','refused')),
        reason TEXT, bytes INTEGER, total INTEGER,
        startedAt INTEGER NOT NULL, finishedAt INTEGER
      );
      CREATE INDEX downloads_conversation ON browser_downloads(conversationId, startedAt);
      PRAGMA user_version = 6;`);
      })();
    if (version < 7)
      this.db.transaction(() => {
        // Which model wrote each reply, now that a chat can change model mid-way.
        this.db.exec(`ALTER TABLE messages ADD COLUMN model TEXT;
      PRAGMA user_version = 7;`);
      })();
    if (version < 8)
      this.db.transaction(() => {
        // The handle that can produce a page again: `artifact:<id>` for a
        // generated document, a folder-relative path for a previewed file. A
        // tab whose page is served by the app is saved by this handle and not
        // by the local address it happened to be at, because that port dies
        // with the app. Nullable: an ordinary web page has no handle, and a
        // tab saved before this column existed reads as one.
        this.db.exec(`ALTER TABLE browser_tabs ADD COLUMN source TEXT;
      PRAGMA user_version = 8;`);
      })();
    if (version < 9)
      this.db.transaction(() => {
        // What was learned about a site on an earlier visit, in the model's own
        // words: the route that works, the control that is not where it looks,
        // the trap. The live page stays the truth — a read hands the note over
        // marked as possibly out of date, and the model corrects or clears it
        // when they disagree. Version 10 gives the note its chat.
        this.db.exec(`CREATE TABLE browser_domain_notes (
        domain TEXT PRIMARY KEY,
        notes TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      PRAGMA user_version = 9;`);
      })();
    if (version < 10)
      this.db.transaction(() => {
        // A note belongs to the chat it was written in. Everything in Hello does:
        // the tabs are the conversation's, the grant on each of them is decided
        // for that tab, and the note is what the model wrote about a page it was
        // let into IN THAT CHAT. Kept for the application, it was a channel
        // between chats that no one had asked for — a note written in a chat on
        // an intranet turned up at the first read of that host anywhere else.
        //
        // A row written under the old shape has no chat, and there is none to
        // infer: attributing it to a conversation would be inventing the one
        // fact that matters. Those rows go, while the table is all but empty,
        // rather than leaving the question to a later version.
        this.db.exec(`DROP TABLE IF EXISTS browser_domain_notes;
      CREATE TABLE browser_domain_notes (
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        notes TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (conversationId, domain)
      );
      PRAGMA user_version = 10;`);
      })();
    if (version < 11)
      this.db.transaction(() => {
        // One notebook with three sections (user, 29.09): Runbooks, Tasks and
        // Plans, each chapter with its own switch. The plan plan_write keeps
        // was the Tasks entry titled "Plan" — the one it replaced whole — and
        // it moves to Plans. SQLite cannot widen a CHECK in place: the table
        // is rebuilt, rows copied as they are.
        this.db.exec(`CREATE TABLE notebooks_next (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('runbook','tasks','plan')),
          title TEXT NOT NULL, body TEXT NOT NULL,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          shared INTEGER NOT NULL DEFAULT 1 CHECK(shared IN (0,1))
        );
        INSERT INTO notebooks_next(id,conversationId,kind,title,body,createdAt,updatedAt,shared)
          SELECT id,conversationId,CASE WHEN kind = 'tasks' AND title = 'Plan' THEN 'plan' ELSE kind END,title,body,createdAt,updatedAt,1 FROM notebooks;
        DROP TABLE notebooks;
        ALTER TABLE notebooks_next RENAME TO notebooks;
        CREATE INDEX notebooks_conversation ON notebooks(conversationId, kind, createdAt);
        PRAGMA user_version = 11;`);
      })();
    if (version < 12)
      this.db.transaction(() => {
        // A reply Pi began on its own, woken by a plugin, says so (user, 29.09).
        const columns = (this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name);
        if (!columns.includes('startedBy')) this.db.exec('ALTER TABLE messages ADD COLUMN startedBy TEXT');
        this.db.exec('PRAGMA user_version = 12');
      })();
    if (version < 13)
      this.db.transaction(() => {
        // The marks an agent left on a page stay with its tab (user, 30.09).
        const columns = (this.db.prepare('PRAGMA table_info(browser_tabs)').all() as Array<{ name: string }>).map(column => column.name);
        if (!columns.includes('marks')) this.db.exec('ALTER TABLE browser_tabs ADD COLUMN marks TEXT');
        this.db.exec('PRAGMA user_version = 13');
      })();
    if (version < 14)
      this.db.transaction(() => {
        // How long a reply worked, across its retries, so its activity says so (user, 04.10).
        const columns = (this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name);
        if (!columns.includes('workedMs')) this.db.exec('ALTER TABLE messages ADD COLUMN workedMs INTEGER');
        this.db.exec('PRAGMA user_version = 14');
      })();
    if (version < 15)
      this.db.transaction(() => {
        // Runbook and Tasks start off in a new chat, like Plans (user, 05.10). A
        // chat that already exists keeps the pages it has: the default it was
        // made with is written down for it.
        for (const page of ['runbook', 'tasks'])
          this.db.prepare(`INSERT INTO settings (key, value) SELECT 'chat-${page}:' || id, 'on' FROM conversations
            WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'chat-${page}:' || conversations.id)`).run();
        this.db.exec('PRAGMA user_version = 15');
      })();
    if (version < 16)
      this.db.transaction(() => {
        const columns = (this.db.pragma('table_info(messages)') as Array<{ name: string }>).map(column => column.name);
        if (!columns.includes('compactions')) this.db.exec('ALTER TABLE messages ADD COLUMN compactions TEXT');
        this.db.exec('PRAGMA user_version = 16');
      })();
    if (version < 17)
      this.db.transaction(() => {
        // The Workbook is off in a new chat (user, 17.11). A chat that already uses it — a section on, or
        // anything written there — keeps it: that is written down for it.
        this.db.prepare(`INSERT INTO settings (key, value) SELECT 'chat-notebook:' || c.id, 'on' FROM conversations c
          WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'chat-notebook:' || c.id)
            AND (EXISTS (SELECT 1 FROM notebooks n WHERE n.conversationId = c.id)
              OR EXISTS (SELECT 1 FROM settings s WHERE s.value = 'on' AND s.key IN ('chat-plan:' || c.id, 'chat-runbook:' || c.id, 'chat-tasks:' || c.id)))`).run();
        this.db.exec('PRAGMA user_version = 17');
      })();
    if (version < 18)
      this.db.transaction(() => {
        // Unclutter (user, 26.11): what to hide on one template of a site, as
        // OpenJev classified it. The person's browsing, not a chat's: the same
        // site looks the same in every chat, so a profile is the app's.
        this.db.exec(`CREATE TABLE IF NOT EXISTS unclutter_profiles (
        key TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        profile TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      PRAGMA user_version = 18;`);
      })();
  }

  // ── Library of skills, plugins and MCP servers ────────────────────────────
  // Rows describe approved resources. Import, verification and execution live
  // in the library/MCP modules; this store never runs or reads their code.
  listResourceRows(): ResourceRow[] {
    return this.db.prepare('SELECT * FROM resources ORDER BY kind, name').all() as ResourceRow[];
  }
  getResourceRow(id: string): ResourceRow {
    const row = this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as ResourceRow | undefined;
    if (!row) throw new Error('This extension is no longer in the library.');
    return row;
  }
  findResourceRow(kind: ResourceKind, name: string): ResourceRow | undefined {
    return this.db.prepare('SELECT * FROM resources WHERE kind = ? AND name = ?').get(kind, name) as ResourceRow | undefined;
  }
  saveResourceRow(row: Omit<ResourceRow, 'createdAt' | 'updatedAt'> & { createdAt?: number }): ResourceRow {
    const now = Date.now();
    const existing = this.db.prepare('SELECT createdAt FROM resources WHERE id = ?').get(row.id) as { createdAt: number } | undefined;
    const clash = this.db.prepare('SELECT id FROM resources WHERE kind = ? AND name = ? AND id <> ?')
      .get(row.kind, row.name, row.id) as { id: string } | undefined;
    if (clash) throw new Error(`Another ${row.kind} named “${row.name}” is already in the library. Remove it first or rename this one.`);
    const record: ResourceRow = { ...row, createdAt: existing?.createdAt ?? row.createdAt ?? now, updatedAt: now };
    this.db.prepare(`INSERT INTO resources (id,kind,name,description,source,version,fingerprint,config,createdAt,updatedAt)
      VALUES (@id,@kind,@name,@description,@source,@version,@fingerprint,@config,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, source=excluded.source,
        version=excluded.version, fingerprint=excluded.fingerprint, config=excluded.config, updatedAt=excluded.updatedAt`)
      .run(record);
    return record;
  }
  deleteResourceRow(id: string): ResourceRow {
    const row = this.getResourceRow(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM resource_activations WHERE resourceId = ?').run(id);
      this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM secrets WHERE key IN (?, ?)').run(`mcpEnv:${id}`, `mcpAuth:${id}`);
    })();
    return row;
  }
  activeResourceIds(conversationId: string): string[] {
    this.getConversation(conversationId);
    return (this.db.prepare(`SELECT a.resourceId FROM resource_activations a
      JOIN resources r ON r.id = a.resourceId WHERE a.conversationId = ? ORDER BY r.kind, r.name`)
      .all(conversationId) as Array<{ resourceId: string }>).map(row => row.resourceId);
  }
  /** Conversations are independent: activation never changes another chat. */
  setResourceActive(conversationId: string, resourceId: string, active: boolean): string[] {
    this.getConversation(conversationId);
    this.getResourceRow(resourceId);
    if (active)
      this.db.prepare('INSERT OR IGNORE INTO resource_activations (conversationId,resourceId) VALUES (?,?)')
        .run(conversationId, resourceId);
    else
      this.db.prepare('DELETE FROM resource_activations WHERE conversationId = ? AND resourceId = ?')
        .run(conversationId, resourceId);
    return this.activeResourceIds(conversationId);
  }
  conversationsUsing(resourceId: string): string[] {
    return (this.db.prepare('SELECT conversationId FROM resource_activations WHERE resourceId = ?')
      .all(resourceId) as Array<{ conversationId: string }>).map(row => row.conversationId);
  }
  /** MCP environment values follow the same encrypted path as the model key. */
  saveResourceSecret(id: string, value: Record<string, string>): void {
    const encrypted = Object.keys(value).length ? this.codec.encrypt(JSON.stringify(value)) : null;
    if (encrypted) this.db.prepare('INSERT INTO secrets(key,encrypted) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET encrypted=excluded.encrypted')
      .run(`mcpEnv:${id}`, encrypted);
    else this.db.prepare('DELETE FROM secrets WHERE key = ?').run(`mcpEnv:${id}`);
  }
  resourceSecret(id: string): Record<string, string> {
    const row = this.db.prepare('SELECT encrypted FROM secrets WHERE key = ?').get(`mcpEnv:${id}`) as { encrypted: Buffer } | undefined;
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(this.codec.decrypt(row.encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch { return {}; }
  }
  /**
   * An HTTP server's sign-in — its client registration and tokens — on the
   * same encrypted path as the model key. Never in a row, the renderer or a log.
   */
  saveResourceAuth(id: string, state: Record<string, unknown> | null): void {
    if (state) this.db.prepare('INSERT INTO secrets(key,encrypted) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET encrypted=excluded.encrypted')
      .run(`mcpAuth:${id}`, this.codec.encrypt(JSON.stringify(state)));
    else this.db.prepare('DELETE FROM secrets WHERE key = ?').run(`mcpAuth:${id}`);
  }
  resourceAuth(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT encrypted FROM secrets WHERE key = ?').get(`mcpAuth:${id}`) as { encrypted: Buffer } | undefined;
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(this.codec.decrypt(row.encrypted));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }
  /** Every stored MCP value and token, so an error message can redact all of them. */
  allResourceSecrets(): string[] {
    const rows = this.db.prepare("SELECT key FROM secrets WHERE key LIKE 'mcpEnv:%' OR key LIKE 'mcpAuth:%'").all() as Array<{ key: string }>;
    return rows.flatMap(row => {
      if (row.key.startsWith('mcpEnv:')) return Object.values(this.resourceSecret(row.key.slice('mcpEnv:'.length)));
      const auth = this.resourceAuth(row.key.slice('mcpAuth:'.length));
      const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens as Record<string, unknown> : {};
      const client = auth?.clientInformation && typeof auth.clientInformation === 'object' ? auth.clientInformation as Record<string, unknown> : {};
      return [tokens.access_token, tokens.refresh_token, client.client_secret].filter((value): value is string => typeof value === 'string');
    }).filter(Boolean);
  }

  listConversations(): Conversation[] {
    return (this.db
      .prepare(`${CONVERSATION_COLUMNS} ORDER BY c.updatedAt DESC, c.id`)
      .all() as StoredConversation[]).map(hydrateConversation);
  }
  getConversation(id: string): Conversation {
    const row = this.db
      .prepare(`${CONVERSATION_COLUMNS} WHERE c.id = ?`)
      .get(id) as StoredConversation | undefined;
    if (!row) throw new Error('Conversation not found.');
    return hydrateConversation(row);
  }
  createConversation(value = 'New chat'): Conversation {
    const now = Date.now();
    const row: Conversation = {
      id: randomUUID(),
      title: title(value, 'New chat'),
      folder: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id,title,folder,createdAt,updatedAt) VALUES (@id,@title,@folder,@createdAt,@updatedAt)',
      )
      .run(row);
    return { ...row, notebook: false, planning: false, runbook: false, tasks: false };
  }
  updateConversation(
    id: string,
    patch: { title?: string; folder?: string | null; notebook?: boolean; planning?: boolean; runbook?: boolean; tasks?: boolean; askFirst?: boolean; model?: ChatModel | null },
  ): Conversation {
    const row = this.getConversation(id);
    if (patch.model !== undefined) {
      if (patch.model) row.model = chatModel(patch.model);
      else delete row.model;
    }
    if (patch.title !== undefined) row.title = title(patch.title, 'New chat');
    if (patch.folder !== undefined) {
      if (patch.folder !== null && !path.isAbsolute(patch.folder))
        throw new Error('Chat folder must be an absolute path.');
      row.folder = patch.folder;
    }
    if (patch.notebook !== undefined && typeof patch.notebook !== 'boolean') throw new Error('The Workbook is on or off.');
    if (patch.planning !== undefined) {
      if (typeof patch.planning !== 'boolean') throw new Error('Planning is on or off.');
      row.planning = patch.planning;
    }
    for (const page of ['runbook', 'tasks'] as const) {
      if (patch[page] === undefined) continue;
      if (typeof patch[page] !== 'boolean') throw new Error(`${page} is on or off.`);
      row[page] = patch[page];
    }
    if (patch.askFirst !== undefined && typeof patch.askFirst !== 'boolean') throw new Error('Ask first is on or off.');
    row.updatedAt = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE conversations SET title=@title,folder=@folder,updatedAt=@updatedAt WHERE id=@id',
        )
        .run({ id: row.id, title: row.title, folder: row.folder, updatedAt: row.updatedAt });
      // Only a section switched on is written; one that is off, the default,
      // is stored as nothing at all.
      const switchRow = (key: string, store: boolean, value: string) => {
        if (store)
          this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(key, value);
        else this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      };
      if (patch.notebook !== undefined) switchRow(`chat-notebook:${id}`, patch.notebook, 'on');
      if (patch.planning !== undefined) switchRow(`chat-plan:${id}`, patch.planning, 'on');
      if (patch.runbook !== undefined) switchRow(`chat-runbook:${id}`, patch.runbook, 'on');
      if (patch.tasks !== undefined) switchRow(`chat-tasks:${id}`, patch.tasks, 'on');
      if (patch.askFirst !== undefined) switchRow(`chat-ask-first:${id}`, true, patch.askFirst ? 'on' : 'off');
      if (patch.model !== undefined) this.writeChatModel(id, row.model ?? null);
    })();
    // A section switched off empties its export: a worker's file is not a way around the switch.
    if (patch.notebook !== undefined || patch.planning !== undefined || patch.runbook !== undefined || patch.tasks !== undefined) this.refreshNotebookExports(id);
    // Read back, not assembled: a section reads as the Workbook lets it.
    return this.getConversation(id);
  }
  /** What the gate asked this chat and is waiting on (chat/gate.ts); nothing while it waits on nothing. Not an
   *  edit of the chat. The shape is the gate's own; a row this version cannot read is as good as none. */
  getGate(id: string): GateState | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`chat-gate:${id}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as Partial<GateState>;
      if (typeof value.request !== 'string' || !Array.isArray(value.questions) || !Array.isArray(value.answers) || typeof value.rounds !== 'number') return null;
      return { request: value.request, understood: typeof value.understood === 'string' ? value.understood : '', questions: value.questions.filter((item): item is string => typeof item === 'string'),
        answers: value.answers.filter((item): item is string => typeof item === 'string'), rounds: value.rounds, at: typeof value.at === 'number' ? value.at : 0 };
    } catch {
      return null;
    }
  }
  /** The last order the gate handed the agent in this chat, in a few lines, so the next request is read as a follow-up to it. */
  getLastOrder(id: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`chat-order:${id}`) as { value: string } | undefined;
    return row?.value || null;
  }
  setLastOrder(id: string, order: string | null): void {
    this.getConversation(id);
    if (order) this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`chat-order:${id}`, order.slice(0, 4_000));
    else this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat-order:${id}`);
  }
  setGate(id: string, state: GateState | null): void {
    this.getConversation(id);
    if (state) this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`chat-gate:${id}`, JSON.stringify(state));
    else this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat-gate:${id}`);
  }
  /** The model a turn ran on becomes the one the chat runs on next (user,
   *  04.10). Not an edit of the chat, so it keeps its place in the list. */
  rememberChatModel(id: string, model: ChatModel): void {
    const next = chatModel(model);
    const current = this.getConversation(id).model;
    if (current?.endpointUrl !== next.endpointUrl || current.id !== next.id) this.writeChatModel(id, next);
  }
  private writeChatModel(id: string, model: ChatModel | null): void {
    if (model)
      this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`chat-model:${id}`, JSON.stringify(model));
    else this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat-model:${id}`);
  }
  /**
   * Messages of every chat that have the words, newest first and at most
   * three per chat, each with the words around the first place they occur.
   * Case is folded as SQLite folds it (Latin letters); the snippet is cut
   * around the first match, found again here with every letter folded.
   */
  searchMessages(query: string, limit = 60): MessageMatch[] {
    const term = query.trim().slice(0, 200);
    if (term.length < 2) return [];
    const pattern = `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`;
    const rows = this.db
      .prepare("SELECT id, conversationId, role, content, createdAt FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY createdAt DESC LIMIT ?")
      .all(pattern, limit * 4) as Array<{ id: string; conversationId: string; role: 'user' | 'assistant'; content: string; createdAt: number }>;
    const perChat = new Map<string, number>();
    const matches: MessageMatch[] = [];
    for (const row of rows) {
      const seen = perChat.get(row.conversationId) ?? 0;
      if (seen >= 3) continue;
      perChat.set(row.conversationId, seen + 1);
      matches.push({ conversationId: row.conversationId, messageId: row.id, role: row.role, createdAt: row.createdAt, snippet: snippetAround(row.content, term) });
      if (matches.length >= limit) break;
    }
    return matches;
  }
  /** The model's memory begins now: only messages from this moment on reach it. */
  restartConversation(id: string, at = Date.now()): Conversation {
    this.setGate(id, null);
    this.setLastOrder(id, null);
    this.getConversation(id);
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`chat-fresh:${id}`, String(at));
    return this.getConversation(id);
  }
  /**
   * The chat as new: its messages, queued messages and restart mark go and,
   * with notes, its notebook (Runbooks, Tasks and Plans). Its browser tabs, downloads, switches,
   * folder and title stay: the tools are the reason to keep the chat at all.
   */
  resetConversation(id: string, options: { notes: boolean }): Conversation {
    this.getConversation(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversationId = ?').run(id);
      this.db.prepare('DELETE FROM queued_messages WHERE conversationId = ?').run(id);
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat-fresh:${id}`);
      if (options.notes) this.db.prepare('DELETE FROM notebooks WHERE conversationId = ?').run(id);
    })();
    if (options.notes) {
      this.refreshNotebookExports(id);
      for (const kind of NOTEBOOK_KINDS) this.notifyNotebooks({ conversationId: id, kind });
    }
    return this.getConversation(id);
  }
  deleteConversation(id: string): void {
    const row = this.getConversation(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`tool-order:${id}`);
      this.db.prepare('DELETE FROM settings WHERE key IN (?,?,?,?,?,?,?,?,?,?)')
        .run(`chat-notebook:${id}`, `chat-mode:${id}`, `chat-plan:${id}`, `chat-runbook:${id}`, `chat-tasks:${id}`, `chat-fresh:${id}`, `chat-model:${id}`,
          `chat-ask-first:${id}`, `chat-gate:${id}`, `chat-order:${id}`);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
    // Remove only our known generated exports, never a user repository.
    const directory = path.join(this.dataDir, 'notebooks', row.id);
    for (const kind of NOTEBOOK_KINDS) {
      const file = path.join(directory, `${kind}.md`);
      if (existsSync(file)) unlinkSync(file);
    }
    if (existsSync(directory)) {
      try {
        rmdirSync(directory);
      } catch {
        /* Preserve any unrelated files. */
      }
    }
  }
  // ── Messages written while the model was still working ────────────────────

  listQueued(conversationId: string): QueuedMessage[] {
    return this.db
      .prepare('SELECT id, conversationId, text, mode, createdAt FROM queued_messages WHERE conversationId = ? ORDER BY position, createdAt')
      .all(conversationId) as QueuedMessage[];
  }
  /** Queue limit: this is a held sentence, not a task list. */
  queueMessage(conversationId: string, text: string, mode: QueuedMode): QueuedMessage {
    this.getConversation(conversationId);
    const body = text.trim().slice(0, 200_000);
    if (!body) throw new Error('Message cannot be empty.');
    if (!['steer', 'next', 'later'].includes(mode)) throw new Error('Unknown delivery.');
    const held = this.db
      .prepare('SELECT COUNT(*) AS held, COALESCE(MAX(position), -1) AS last FROM queued_messages WHERE conversationId = ?')
      .get(conversationId) as { held: number; last: number };
    if (held.held >= 8) throw new Error('Too many messages are waiting in this chat. Send or remove one first.');
    const row: QueuedMessage = {
      id: randomUUID(), conversationId, text: body, mode, createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO queued_messages (id, conversationId, text, mode, position, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.conversationId, row.text, row.mode, held.last + 1, row.createdAt);
    return row;
  }
  /** Changing your mind before it is said: new words, or a different landing. */
  reviseQueued(id: string, patch: { text?: string; mode?: QueuedMode }): QueuedMessage {
    const current = this.db.prepare('SELECT id, conversationId, text, mode, createdAt FROM queued_messages WHERE id = ?')
      .get(id) as QueuedMessage | undefined;
    if (!current) throw new Error('That message is no longer waiting.');
    const text = patch.text === undefined ? current.text : patch.text.trim().slice(0, 200_000);
    if (!text) throw new Error('Message cannot be empty.');
    const mode = patch.mode ?? current.mode;
    if (!['steer', 'next', 'later'].includes(mode)) throw new Error('Unknown delivery.');
    this.db.prepare('UPDATE queued_messages SET text = ?, mode = ? WHERE id = ?').run(text, mode, id);
    return { ...current, text, mode };
  }
  getQueued(id: string): QueuedMessage {
    const row = this.db
      .prepare('SELECT id, conversationId, text, mode, createdAt FROM queued_messages WHERE id = ?')
      .get(id) as QueuedMessage | undefined;
    if (!row) throw new Error('That message is no longer waiting.');
    return row;
  }
  dropQueued(id: string): void {
    this.db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id);
  }
  /** Takes the next message meant to be said on its own, and forgets it here. */
  takeQueued(conversationId: string, modes: QueuedMode[]): QueuedMessage | undefined {
    const row = this.listQueued(conversationId).find(item => modes.includes(item.mode));
    if (row) this.dropQueued(row.id);
    return row;
  }

  /**
   * What every reply has cost and moved, added up (user, 04.10, the second
   * design audit: cost lived only inside one chat's meter, with no total and
   * no way to see which model or chat spends it). Read from the usage each
   * reply already keeps; a reply without one counts for nothing.
   */
  usageSummary(): UsageSummary {
    const rows = this.db.prepare(`SELECT m.conversationId AS conversationId, c.title AS title, m.model AS model,
        COALESCE(json_extract(m.usage, '$.input'), 0) AS input, COALESCE(json_extract(m.usage, '$.output'), 0) AS output,
        COALESCE(json_extract(m.usage, '$.cost'), 0) AS cost
      FROM messages m JOIN conversations c ON c.id = m.conversationId
      WHERE m.role = 'assistant' AND m.usage IS NOT NULL`).all() as Array<{ conversationId: string; title: string; model: string | null; input: number; output: number; cost: number }>;
    const total = { replies: 0, input: 0, output: 0, cost: 0 };
    const models = new Map<string, UsageSummary['models'][number]>();
    const chats = new Map<string, UsageSummary['chats'][number]>();
    for (const row of rows) {
      const input = Number(row.input) || 0, output = Number(row.output) || 0, cost = Number(row.cost) || 0;
      const add = <T extends { replies: number; input: number; output: number; cost: number }>(into: T) => {
        into.replies += 1; into.input += input; into.output += output; into.cost += cost;
      };
      add(total);
      const model = row.model || 'Unknown model';
      add(models.get(model) ?? models.set(model, { model, replies: 0, input: 0, output: 0, cost: 0 }).get(model)!);
      add(chats.get(row.conversationId) ?? chats.set(row.conversationId, { conversationId: row.conversationId, title: row.title, replies: 0, input: 0, output: 0, cost: 0 }).get(row.conversationId)!);
    }
    const heaviest = (a: { cost: number; input: number; output: number }, b: { cost: number; input: number; output: number }) =>
      b.cost - a.cost || (b.input + b.output) - (a.input + a.output);
    return { ...total, models: [...models.values()].sort(heaviest), chats: [...chats.values()].sort(heaviest).slice(0, 5) };
  }

  listMessages(conversationId: string): Message[] {
    this.getConversation(conversationId);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY seq')
      .all(conversationId) as Array<
      Omit<Message, 'compactions'> & { compactions: string | null; parts: string; usage: string | null; model: string | null; startedBy: string | null; workedMs: number | null }
    >;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      parts: parse(row.parts, []),
      status: row.status,
      createdAt: row.createdAt,
      error: row.error,
      usage: parse(row.usage, undefined),
      compactions: parse(row.compactions, undefined),
      ...(row.model ? { model: row.model } : {}),
      ...(row.startedBy ? { startedBy: row.startedBy } : {}),
      ...(row.workedMs ? { workedMs: row.workedMs } : {}),
    }));
  }
  toolOrder(conversationId: string): string[] {
    this.getConversation(conversationId);
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`tool-order:${conversationId}`) as { value: string } | undefined;
    const saved: unknown = parse(row?.value, []);
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
  }
  saveToolOrder(conversationId: string, order: unknown): string[] {
    this.getConversation(conversationId);
    if (!Array.isArray(order) || order.length > 500 || order.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(order).size !== order.length)
      throw new Error('Invalid tool tab order.');
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`tool-order:${conversationId}`, JSON.stringify(order));
    return order;
  }
  saveMessage(message: Message): Message {
    this.getConversation(message.conversationId);
    const current = this.db
      .prepare('SELECT conversationId FROM messages WHERE id = ?')
      .get(message.id) as { conversationId: string } | undefined;
    if (current && current.conversationId !== message.conversationId)
      throw new Error('Message belongs to another conversation.');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id,conversationId,role,content,parts,status,createdAt,error,usage,model,startedBy,workedMs,compactions)
        VALUES (@id,@conversationId,@role,@content,@parts,@status,@createdAt,@error,@usage,@model,@startedBy,@workedMs,@compactions)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, parts=excluded.parts,
          status=excluded.status, error=excluded.error, usage=excluded.usage, model=COALESCE(excluded.model, messages.model),
          startedBy=COALESCE(excluded.startedBy, messages.startedBy), workedMs=COALESCE(excluded.workedMs, messages.workedMs), compactions=excluded.compactions`,
        )
        .run({
          ...message,
          parts: JSON.stringify(message.parts ?? []),
          error: message.error ?? null,
          usage: message.usage ? JSON.stringify(message.usage) : null,
          model: message.model ?? null,
          startedBy: message.startedBy ?? null,
          workedMs: message.workedMs ?? null,
          compactions: message.compactions ? JSON.stringify(message.compactions) : null,
        });
      this.db
        .prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?')
        .run(Date.now(), message.conversationId);
    })();
    return message;
  }
  deleteMessagesAfter(
    conversationId: string,
    messageId: string,
    inclusive = false,
  ): void {
    this.getConversation(conversationId);
    const row = this.db
      .prepare('SELECT seq FROM messages WHERE id = ? AND conversationId = ?')
      .get(messageId, conversationId) as { seq: number } | undefined;
    if (!row) throw new Error('Message not found in this conversation.');
    this.db
      .prepare(
        `DELETE FROM messages WHERE conversationId = ? AND seq ${inclusive ? '>=' : '>'} ?`,
      )
      .run(conversationId, row.seq);
  }
  getSettings(): AppSettings {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'app'")
      .get() as { value: string } | undefined;
    const settings = {
      ...DEFAULT_SETTINGS,
      ...parse<Partial<StoredSettings>>(row?.value, {}),
    };
    const connections = (Array.isArray(settings.connections) ? settings.connections : [])
      .filter((entry): entry is StoredConnection =>
        Boolean(entry) && typeof entry.name === 'string' && typeof entry.endpointUrl === 'string')
      .map(entry => ({
        name: entry.name,
        endpointUrl: entry.endpointUrl,
        model: typeof entry.model === 'string' ? entry.model : '',
        apiKeySet: this.hasApiKey(entry.endpointUrl),
      }));
    return { ...settings, connections, apiKeySet: this.hasApiKey(settings.endpointUrl) };
  }
  private hasApiKey(endpointUrl: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM secrets WHERE key = ?').get(`apiKey:${endpointUrl}`));
  }
  saveSettings(patch: SettingsPatch): AppSettings {
    const current = this.getSettings();
    const next: StoredSettings = {
      connections: current.connections.map(({ apiKeySet: _apiKeySet, ...entry }) => entry),
      endpointUrl:
        patch.endpointUrl !== undefined
          ? normalizeEndpoint(patch.endpointUrl)
          : current.endpointUrl,
      model:
        patch.model !== undefined
          ? patch.model.trim().slice(0, 500)
          : current.model,
      systemPrompt:
        patch.systemPrompt !== undefined
          ? patch.systemPrompt.slice(0, 100_000)
          : current.systemPrompt,
      temperature: patch.temperature ?? current.temperature,
      reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
      contextWindow: patch.contextWindow ?? current.contextWindow ?? 32768,
      maxOutputTokens: patch.maxOutputTokens ?? current.maxOutputTokens ?? 4096,
      modelCompatibility: patch.modelCompatibility ?? current.modelCompatibility ?? 'auto',
      approvals: patch.approvals ?? current.approvals ?? 'all',
      appearance: patch.appearance ?? current.appearance ?? 'system',
      subagentModel: patch.subagentModel !== undefined ? (patch.subagentModel.trim().slice(0, 500) || undefined) : current.subagentModel,
      subagentEndpointUrl: patch.subagentEndpointUrl !== undefined ? (patch.subagentEndpointUrl.trim() ? normalizeEndpoint(patch.subagentEndpointUrl) : undefined) : current.subagentEndpointUrl,
      // What was learned about one model does not carry to the next.
      contextScale: patch.contextScale ?? current.contextScale,
      voice: patch.voice !== undefined ? nextVoice(current.voice, patch.voice) : current.voice,
    };
    // A model id is its provider's: another connection starts from the chat's own model again.
    // One placed on a connection of its own stays there whatever the chat moves to.
    if (patch.subagentModel === undefined && next.endpointUrl !== current.endpointUrl && !next.subagentEndpointUrl) delete next.subagentModel;
    // No model, no connection for it; and the chat's own connection is not "another".
    if (!next.subagentModel || (next.subagentEndpointUrl && normalizeEndpoint(next.subagentEndpointUrl) === normalizeEndpoint(next.endpointUrl))) delete next.subagentEndpointUrl;
    // Only a connection the person kept: its key is what the subagents will be sent with.
    if (next.subagentEndpointUrl && !current.connections.some(entry => normalizeEndpoint(entry.endpointUrl) === next.subagentEndpointUrl))
      throw new Error('Subagents can run on the chat’s connection or on one you kept. Keep that connection first.');
    // Provenance for the two numbers Pi launches on. Writing either one claims
    // them for the endpoint and model in force, so a deliberate value is never
    // replaced by a published one; pointing at a different model or provider
    // drops the claim, and main looks the limits up again before the next turn.
    next.limitsFor =
      patch.contextWindow !== undefined || patch.maxOutputTokens !== undefined
        ? limitsKey(next.endpointUrl, next.model)
        : current.limitsFor;
    if (limitsKey(next.endpointUrl, next.model) !== limitsKey(current.endpointUrl, current.model))
      next.contextScale = patch.contextScale;
    if (next.contextScale !== undefined &&
        (!Number.isFinite(next.contextScale) || next.contextScale <= 0 || next.contextScale > 1))
      throw new Error('Context scale must be greater than 0 and at most 1.');
    if (
      !Number.isFinite(next.temperature) ||
      next.temperature < 0 ||
      next.temperature > 2
    )
      throw new Error('Temperature must be between 0 and 2.');
    if (
      next.reasoningEffort &&
      !['off', 'low', 'medium', 'high'].includes(next.reasoningEffort)
    )
      throw new Error('Invalid reasoning effort.');
    if (!Number.isInteger(next.contextWindow) || next.contextWindow! < 4096 || next.contextWindow! > 2_000_000)
      throw new Error('Context window must be between 4,096 and 2,000,000 tokens, matching the server.');
    if (!Number.isInteger(next.maxOutputTokens) || next.maxOutputTokens! < 512 || next.maxOutputTokens! > next.contextWindow! / 2)
      throw new Error('Output budget must be at least 512 tokens and at most half the context window.');
    if (next.contextWindow! - Math.max(16384, next.maxOutputTokens! + 4096) < 4096)
      throw new Error('This Pi profile needs at least 20,480 context tokens, and more for larger output budgets. Match an actually loaded server context; do not enter a larger value than the server supports.');
    if (!['auto', 'openai', 'qwen-chat-template'].includes(next.modelCompatibility!))
      throw new Error('Invalid model compatibility.');
    if (!['ask', 'writes', 'all'].includes(next.approvals!))
      throw new Error('Invalid approval mode.');
    if (!['system', 'light', 'dark'].includes(next.appearance!))
      throw new Error('Appearance is System, Light or Dark.');
    // A remembered entry for this endpoint follows the model saved for it, so
    // switching away and back does not silently restore an older model.
    next.connections = next.connections.map(entry =>
      entry.endpointUrl === next.endpointUrl ? { ...entry, model: next.model } : entry);
    const key = patch.apiKey?.trim();
    // Encryption happens before any database write. Failure never stores plaintext.
    const encrypted = key ? this.codec.encrypt(key) : null;
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(next));
      if (key !== undefined) {
        if (encrypted)
          this.db
            .prepare(
              'INSERT INTO secrets(key,encrypted) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET encrypted=excluded.encrypted',
            )
            .run(`apiKey:${next.endpointUrl}`, encrypted);
        else
          this.db
            .prepare('DELETE FROM secrets WHERE key = ?')
            .run(`apiKey:${next.endpointUrl}`);
      }
    })();
    return this.getSettings();
  }
  /** Keeps the endpoint and model exactly as saved, under a name the user can find again. */
  rememberConnection(name: string): AppSettings {
    const label = name.trim().slice(0, 60);
    if (!label) throw new Error('Give this connection a name.');
    const current = this.getSettings();
    const endpointUrl = normalizeEndpoint(current.endpointUrl);
    if (current.connections.some(entry =>
      entry.endpointUrl !== endpointUrl && entry.name.toLowerCase() === label.toLowerCase()))
      throw new Error(`“${label}” already names another connection.`);
    const known = current.connections.some(entry => entry.endpointUrl === endpointUrl);
    if (!known && current.connections.length >= CONNECTION_LIMIT)
      throw new Error(`Keep at most ${CONNECTION_LIMIT} connections. Forget one first.`);
    const entry: StoredConnection = { name: label, endpointUrl, model: current.model };
    // Replacing in place keeps the list in the order the user built it.
    const connections = known
      ? current.connections.map(saved => (saved.endpointUrl === endpointUrl ? entry : strip(saved)))
      : [...current.connections.map(strip), entry];
    return this.writeConnections(connections);
  }
  /** Points the app at a remembered connection. Its stored key is already keyed by that endpoint. */
  useConnection(endpointUrl: string): AppSettings {
    const wanted = normalizeEndpoint(endpointUrl);
    const entry = this.getSettings().connections.find(saved => saved.endpointUrl === wanted);
    if (!entry) throw new Error('That connection is no longer saved.');
    return this.saveSettings({ endpointUrl: entry.endpointUrl, model: entry.model });
  }
  /** Forgets a connection and deletes the key stored for its endpoint. */
  forgetConnection(endpointUrl: string): AppSettings {
    const wanted = normalizeEndpoint(endpointUrl);
    const current = this.getSettings();
    if (wanted === normalizeEndpoint(current.endpointUrl))
      throw new Error('This is the connection in use. Switch to another one first.');
    if (!current.connections.some(entry => entry.endpointUrl === wanted))
      throw new Error('That connection is no longer saved.');
    return this.writeConnections(
      current.connections.filter(entry => entry.endpointUrl !== wanted).map(strip),
      () => {
        this.db.prepare('DELETE FROM secrets WHERE key = ?').run(`apiKey:${wanted}`);
        // A chat that ran on it follows the selection again: its key went with it.
        this.db.prepare("DELETE FROM settings WHERE key LIKE 'chat-model:%' AND json_extract(value, '$.endpointUrl') = ?").run(wanted);
      },
    );
  }
  private writeConnections(connections: StoredConnection[], also?: () => void): AppSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
    const stored: StoredSettings = { ...DEFAULT_SETTINGS, ...parse<Partial<StoredSettings>>(row?.value, {}), connections };
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO settings(key,value) VALUES ('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(stored));
      also?.();
    })();
    return this.getSettings();
  }
  getApiKey(endpointUrl = this.getSettings().endpointUrl): string {
    const row = this.db
      .prepare('SELECT encrypted FROM secrets WHERE key = ?')
      .get(`apiKey:${normalizeEndpoint(endpointUrl)}`) as
      { encrypted: Buffer } | undefined;
    return row ? this.codec.decrypt(row.encrypted) : '';
  }
  subscribeNotebooks(listener: (change: NotebookChange) => void): () => void {
    this.notebookListeners.add(listener);
    return () => { this.notebookListeners.delete(listener); };
  }
  private notifyNotebooks(change: NotebookChange): void {
    for (const listener of this.notebookListeners) {
      try { listener(change); } catch { /* A committed notebook save stays successful. */ }
    }
  }
  private refreshNotebookExports(conversationId: string): void {
    // SQLite is authoritative. A derived Markdown export failure cannot turn
    // an already committed write into an apparent failure (and invite a retry
    // which duplicates it). Explicit notebookPaths requests still report I/O
    // errors and retry the export; listeners always learn about the DB change.
    try { this.notebookPaths(conversationId); } catch { /* Derived cache only. */ }
  }
  listNotebooks(conversationId: string, kind: NotebookKind): NotebookEntry[] {
    this.getConversation(conversationId);
    validKind(kind);
    return (this.db
      .prepare(
        'SELECT * FROM notebooks WHERE conversationId = ? AND kind = ? ORDER BY createdAt, id',
      )
      .all(conversationId, kind) as StoredNotebook[]).map(hydrateNotebook);
  }
  saveNotebook(input: NotebookInput): NotebookEntry {
    this.getConversation(input.conversationId);
    validKind(input.kind);
    const stored = input.id
      ? (this.db
          .prepare('SELECT * FROM notebooks WHERE id = ?')
          .get(input.id) as StoredNotebook | undefined)
      : undefined;
    const old = stored ? hydrateNotebook(stored) : undefined;
    if (input.id && !old) throw new Error('Notebook entry not found.');
    if (
      old &&
      (old.conversationId !== input.conversationId || old.kind !== input.kind)
    )
      throw new Error('Notebook entry belongs to another notebook.');
    if (input.expectedUpdatedAt !== undefined) {
      if (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 0)
        throw new Error('Invalid notebook revision.');
      if (!old || old.updatedAt !== input.expectedUpdatedAt)
        throw new Error('Notebook changed since this draft was opened. Reload the latest entry or save your draft as a new entry.');
    }
    if (input.body.length > 2_000_000)
      throw new Error('Notebook entry is too large (maximum 2 MB).');
    const now = Math.max(Date.now(), (old?.updatedAt ?? 0) + 1);
    const row: NotebookEntry = {
      conversationId: input.conversationId,
      kind: input.kind,
      body: input.body,
      id: old?.id ?? randomUUID(),
      title: title(input.title, 'Untitled'),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      // A new chapter is on; a save never moves the switch.
      shared: old?.shared ?? true,
    };
    this.db
      .prepare(
        `INSERT INTO notebooks(id,conversationId,kind,title,body,createdAt,updatedAt,shared)
      VALUES (@id,@conversationId,@kind,@title,@body,@createdAt,@updatedAt,@shared)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updatedAt=excluded.updatedAt`,
      )
      .run({ ...row, shared: row.shared ? 1 : 0 });
    this.refreshNotebookExports(input.conversationId);
    this.notifyNotebooks({ conversationId: input.conversationId, kind: input.kind });
    return row;
  }
  deleteNotebook(id: string): void {
    const old = this.db
      .prepare('SELECT * FROM notebooks WHERE id = ?')
      .get(id) as NotebookEntry | undefined;
    if (!old) throw new Error('Notebook entry not found.');
    this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
    this.refreshNotebookExports(old.conversationId);
    this.notifyNotebooks({ conversationId: old.conversationId, kind: old.kind });
  }
  /**
   * A chapter's switch: whether the model and CLI workers see it. Its words
   * and revision stay as they are, so a draft open on it saves normally.
   */
  shareNotebook(id: string, shared: boolean): NotebookEntry {
    const stored = this.db.prepare('SELECT * FROM notebooks WHERE id = ?').get(id) as StoredNotebook | undefined;
    if (!stored) throw new Error('Notebook entry not found.');
    this.db.prepare('UPDATE notebooks SET shared = ? WHERE id = ?').run(shared ? 1 : 0, id);
    this.refreshNotebookExports(stored.conversationId);
    this.notifyNotebooks({ conversationId: stored.conversationId, kind: stored.kind });
    return { ...hydrateNotebook(stored), shared };
  }
  notebookPaths(conversationId: string): NotebookPaths {
    const conversation = this.getConversation(conversationId);
    const directory = path.join(this.dataDir, 'notebooks', conversation.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files: NotebookPaths = {
      runbook: path.join(directory, 'runbook.md'),
      tasks: path.join(directory, 'tasks.md'),
      plan: path.join(directory, 'plan.md'),
    };
    const on = { runbook: conversation.runbook === true, tasks: conversation.tasks === true, plan: conversation.planning === true };
    for (const kind of NOTEBOOK_KINDS) {
      // What a worker may read: a section that is on, and of Runbooks only the chapters that are on.
      const text = (on[kind] ? this.listNotebooks(conversationId, kind) : []).filter(entry => kind !== 'runbook' || entry.shared)
        .map((entry) => `# ${entry.title}\n\n${entry.body.trimEnd()}\n`)
        .join('\n');
      if (existsSync(files[kind]) && readFileSync(files[kind], 'utf8') === text)
        continue;
      atomicWriteFileSync(files[kind], text);
    }
    return files;
  }
  exportConversation(conversationId: string): string {
    const conversation = this.getConversation(conversationId);
    const messages = this.listMessages(conversationId);
    return (
      `# ${conversation.title}\n\n` +
      messages
        .map((message, index) => {
          const tools = (message.parts ?? [])
            .filter((part) => part.type === 'tool')
            .map((part) =>
              part.type === 'tool'
                ? `\n\nTool: ${part.name}\n\n${part.output ?? part.status}`
                : '',
            )
            .join('');
          const content = message.role === 'assistant' ? withSourceLinks(message.content, sourcesForMessage(message, fetchedSources(messages.slice(0, index)))) : message.content;
          return `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${content}${tools}\n`;
        })
        .join('\n')
    );
  }
  listBrowserTabs(): BrowserTab[] {
    const rows = this.db
      .prepare('SELECT * FROM browser_tabs ORDER BY rowid')
      .all() as Array<
      Pick<BrowserTab, 'id' | 'conversationId' | 'title' | 'url'> & { control?: string; source?: string | null; marks?: string | null }
    >;
    return rows.map(({ control, source, marks, ...row }) => ({
      ...row,
      // What the human chose for this page, kept between sessions.
      control: control === 'read' || control === 'full' ? control : 'off',
      // The handle that produces this page again, when the page has one. Absent
      // rather than empty: the browser asks `!tab.source` to tell an ordinary
      // web page from one the app serves, and an empty string is not a handle.
      ...(typeof source === 'string' && source ? { source } : {}),
      ...(storedMarks(marks) ? { marks: storedMarks(marks) } : {}),
      loading: false,
      progress: null,
      canGoBack: false,
      canGoForward: false,
    }));
  }
  saveBrowserTab(tab: BrowserTab): void {
    this.getConversation(tab.conversationId);
    const old = this.db
      .prepare('SELECT conversationId FROM browser_tabs WHERE id = ?')
      .get(tab.id) as { conversationId: string } | undefined;
    if (old && old.conversationId !== tab.conversationId)
      throw new Error('Browser tab belongs to another conversation.');
    this.db
      .prepare(
        `INSERT INTO browser_tabs(id,conversationId,title,url,control,source,marks) VALUES (@id,@conversationId,@title,@url,@control,@source,@marks)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,control=excluded.control,source=excluded.source,marks=excluded.marks`,
      )
      .run({
        id: tab.id,
        conversationId: tab.conversationId,
        title: tab.title,
        url: tab.url,
        // Only the human's grant is kept: the Full a tab got because the model
        // opened it was for that session's work (user, 29.09).
        control: !tab.agentGranted && (tab.control === 'read' || tab.control === 'full') ? tab.control : 'off',
        // A tab that navigates away from the page the app served for it loses
        // its handle, and the row must lose it too: NULL, not the old handle.
        source: typeof tab.source === 'string' && tab.source ? tab.source : null,
        // Each page's marks, kept until the person reloads that page or clears them.
        marks: tab.marks?.length ? JSON.stringify(tab.marks) : null,
      });
  }
  deleteBrowserTab(id: string): void {
    this.db.prepare('DELETE FROM browser_tabs WHERE id = ?').run(id);
  }
  /**
   * What this chat's earlier visits learned about one site, and when, or nothing
   * at all. Another chat's note about the same site is not this chat's to read.
   */
  getDomainNote(conversationId: string, domain: string): { notes: string; updatedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT notes, updatedAt FROM browser_domain_notes WHERE conversationId = ? AND domain = ?')
      .get(conversationId, domain) as { notes?: unknown; updatedAt?: unknown } | undefined;
    if (typeof row?.notes !== 'string' || !row.notes) return undefined;
    return { notes: row.notes, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0 };
  }
  /**
   * One note per site per chat: writing again replaces it, which is how a wrong
   * one is corrected. The note goes with the chat when the chat goes.
   */
  saveDomainNote(conversationId: string, domain: string, notes: string): void {
    this.getConversation(conversationId);
    this.db
      .prepare(
        `INSERT INTO browser_domain_notes(conversationId,domain,notes,updatedAt) VALUES (?,?,?,?)
      ON CONFLICT(conversationId,domain) DO UPDATE SET notes=excluded.notes,updatedAt=excluded.updatedAt`,
      )
      .run(conversationId, domain, notes, Date.now());
  }
  deleteDomainNote(conversationId: string, domain: string): void {
    this.db
      .prepare('DELETE FROM browser_domain_notes WHERE conversationId = ? AND domain = ?')
      .run(conversationId, domain);
  }
  /** One site template's Unclutter profile, as saved; the caller checks its shape. */
  getUnclutterProfile(key: string): unknown {
    const row = this.db.prepare('SELECT profile FROM unclutter_profiles WHERE key = ?').get(key) as { profile?: unknown } | undefined;
    if (typeof row?.profile !== 'string') return null;
    try { return JSON.parse(row.profile); } catch { return null; }
  }
  saveUnclutterProfile(profile: { key: string; origin: string }): void {
    this.db
      .prepare('INSERT INTO unclutter_profiles(key,origin,profile,updatedAt) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET origin=excluded.origin,profile=excluded.profile,updatedAt=excluded.updatedAt')
      .run(profile.key, profile.origin, JSON.stringify(profile), Date.now());
  }
  deleteUnclutterProfile(key: string): void {
    this.db.prepare('DELETE FROM unclutter_profiles WHERE key = ?').run(key);
  }
  /** Unclutter's switches, as saved; the caller checks their shape. */
  getUnclutterSettings(): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('unclutter') as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string') return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }
  saveUnclutterSettings(settings: { enabled: boolean; auto: boolean }): void {
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('unclutter', JSON.stringify(settings));
  }
  /** Every chat's downloads, oldest first. */
  listBrowserDownloads(): BrowserDownload[] {
    const rows = this.db
      .prepare('SELECT * FROM browser_downloads ORDER BY startedAt, rowid')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const download: BrowserDownload = {
        id: row.id as string, conversationId: row.conversationId as string, name: row.name as string,
        state: row.state as BrowserDownload['state'], startedAt: row.startedAt as number,
      };
      for (const key of ['tabId', 'path', 'url', 'mimeType', 'reason'] as const)
        if (typeof row[key] === 'string') download[key] = row[key] as string;
      for (const key of ['bytes', 'total', 'finishedAt'] as const)
        if (typeof row[key] === 'number') download[key] = row[key] as number;
      return download;
    });
  }
  saveBrowserDownload(download: BrowserDownload): void {
    this.getConversation(download.conversationId);
    this.db
      .prepare(
        `INSERT INTO browser_downloads(id,conversationId,tabId,name,path,url,mimeType,state,reason,bytes,total,startedAt,finishedAt)
      VALUES (@id,@conversationId,@tabId,@name,@path,@url,@mimeType,@state,@reason,@bytes,@total,@startedAt,@finishedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,url=excluded.url,mimeType=excluded.mimeType,
        state=excluded.state,reason=excluded.reason,bytes=excluded.bytes,total=excluded.total,finishedAt=excluded.finishedAt`,
      )
      .run({
        id: download.id, conversationId: download.conversationId, tabId: download.tabId ?? null, name: download.name,
        path: download.path ?? null, url: download.url ?? null, mimeType: download.mimeType ?? null, state: download.state,
        reason: download.reason ?? null, bytes: download.bytes ?? null, total: download.total ?? null,
        startedAt: download.startedAt, finishedAt: download.finishedAt ?? null,
      });
  }
  deleteBrowserDownload(id: string): void {
    this.db.prepare('DELETE FROM browser_downloads WHERE id = ?').run(id);
  }
  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** Marks read back from a tab's row: only what is shaped like them — at most ten pages, six marks each. */
function storedMarks(value: string | null | undefined): TabMarks[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    // One page, as the first version of this column kept them.
    const pages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ url?: unknown; marks?: unknown }>;
    const kept = pages.flatMap(page => {
      if (!page || typeof page.url !== 'string' || !Array.isArray(page.marks)) return [];
      const marks = page.marks.filter((mark): mark is TabMark => Boolean(mark) && typeof mark === 'object'
        && ['n', 'x', 'y', 'width', 'height'].every(key => Number.isFinite((mark as Record<string, unknown>)[key]))
        && typeof (mark as TabMark).note === 'string'
        && ((mark as TabMark).path === undefined || typeof (mark as TabMark).path === 'string')).slice(0, 6);
      return marks.length ? [{ url: page.url, marks }] : [];
    }).slice(-10);
    return kept.length ? kept : undefined;
  } catch { return undefined; }
}

export function createDataStore(
  dataDir: string,
  codec: SecretCodec,
): DataStore {
  return new DataStore(dataDir, codec);
}
