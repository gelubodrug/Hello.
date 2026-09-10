import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fetchedSources, sourcesForMessage, withSourceLinks } from '../../shared/web';
import type {
  AppSettings,
  SavedConnection,
  LibraryResource,
  ResourceKind,
  BrowserTab,
  Conversation,
  Message,
  NotebookEntry,
  NotebookChange,
  NotebookKind,
  NotebookPaths,
  SettingsPatch,
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
};

const strip = ({ apiKeySet: _apiKeySet, ...entry }: SavedConnection): StoredConnection => entry;

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

function title(value: string, fallback: string): string {
  const result = value.trim().slice(0, 250);
  return result || fallback;
}
function validKind(kind: string): asserts kind is NotebookKind {
  if (kind !== 'runbook' && kind !== 'tasks')
    throw new Error('Unknown notebook kind.');
}
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
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(this.databasePath + suffix))
        chmodSync(this.databasePath + suffix, 0o600);
    }
  }

  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 3)
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
      this.db.prepare('DELETE FROM secrets WHERE key = ?').run(`mcpEnv:${id}`);
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
  /** Every stored MCP value, so an error message can redact all of them. */
  allResourceSecrets(): string[] {
    const rows = this.db.prepare("SELECT key FROM secrets WHERE key LIKE 'mcpEnv:%'").all() as Array<{ key: string }>;
    return rows.flatMap(row => Object.values(this.resourceSecret(row.key.slice('mcpEnv:'.length)))).filter(Boolean);
  }

  listConversations(): Conversation[] {
    return this.db
      .prepare(`SELECT c.*, CASE WHEN s.value = 'coder' THEN 'coder' ELSE 'chat' END AS chatMode
        FROM conversations c LEFT JOIN settings s ON s.key = ? || c.id
        ORDER BY c.updatedAt DESC, c.id`)
      .all('chat-mode:') as Conversation[];
  }
  getConversation(id: string): Conversation {
    const row = this.db
      .prepare(`SELECT c.*, CASE WHEN s.value = 'coder' THEN 'coder' ELSE 'chat' END AS chatMode
        FROM conversations c LEFT JOIN settings s ON s.key = ? || c.id WHERE c.id = ?`)
      .get('chat-mode:', id) as Conversation | undefined;
    if (!row) throw new Error('Conversation not found.');
    return row;
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
    return { ...row, chatMode: 'chat' };
  }
  updateConversation(
    id: string,
    patch: { title?: string; folder?: string | null; chatMode?: 'chat' | 'coder' },
  ): Conversation {
    const row = this.getConversation(id);
    if (patch.title !== undefined) row.title = title(patch.title, 'New chat');
    if (patch.folder !== undefined) {
      if (patch.folder !== null && !path.isAbsolute(patch.folder))
        throw new Error('Chat folder must be an absolute path.');
      row.folder = patch.folder;
    }
    if (patch.chatMode !== undefined) {
      if (patch.chatMode !== 'chat' && patch.chatMode !== 'coder')
        throw new Error('Unknown chat mode.');
      row.chatMode = patch.chatMode;
    }
    row.updatedAt = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE conversations SET title=@title,folder=@folder,updatedAt=@updatedAt WHERE id=@id',
        )
        .run({ id: row.id, title: row.title, folder: row.folder, updatedAt: row.updatedAt });
      if (patch.chatMode !== undefined)
        this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(`chat-mode:${id}`, patch.chatMode);
    })();
    return row;
  }
  deleteConversation(id: string): void {
    const row = this.getConversation(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat-mode:${id}`);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
    // Remove only our two known generated exports, never a user repository.
    const directory = path.join(this.dataDir, 'notebooks', row.id);
    for (const kind of ['runbook', 'tasks']) {
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
  listMessages(conversationId: string): Message[] {
    this.getConversation(conversationId);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY seq')
      .all(conversationId) as Array<
      Message & { parts: string; usage: string | null }
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
    }));
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
          `INSERT INTO messages (id,conversationId,role,content,parts,status,createdAt,error,usage)
        VALUES (@id,@conversationId,@role,@content,@parts,@status,@createdAt,@error,@usage)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, parts=excluded.parts,
          status=excluded.status, error=excluded.error, usage=excluded.usage`,
        )
        .run({
          ...message,
          parts: JSON.stringify(message.parts ?? []),
          error: message.error ?? null,
          usage: message.usage ? JSON.stringify(message.usage) : null,
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
    };
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
      () => { this.db.prepare('DELETE FROM secrets WHERE key = ?').run(`apiKey:${wanted}`); },
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
    return this.db
      .prepare(
        'SELECT * FROM notebooks WHERE conversationId = ? AND kind = ? ORDER BY createdAt, id',
      )
      .all(conversationId, kind) as NotebookEntry[];
  }
  saveNotebook(input: NotebookInput): NotebookEntry {
    this.getConversation(input.conversationId);
    validKind(input.kind);
    const old = input.id
      ? (this.db
          .prepare('SELECT * FROM notebooks WHERE id = ?')
          .get(input.id) as NotebookEntry | undefined)
      : undefined;
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
    };
    this.db
      .prepare(
        `INSERT INTO notebooks(id,conversationId,kind,title,body,createdAt,updatedAt)
      VALUES (@id,@conversationId,@kind,@title,@body,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updatedAt=excluded.updatedAt`,
      )
      .run(row);
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
  notebookPaths(conversationId: string): NotebookPaths {
    const conversation = this.getConversation(conversationId);
    const directory = path.join(this.dataDir, 'notebooks', conversation.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files: NotebookPaths = {
      runbook: path.join(directory, 'runbook.md'),
      tasks: path.join(directory, 'tasks.md'),
    };
    for (const kind of ['runbook', 'tasks'] as const) {
      const text = this.listNotebooks(conversationId, kind)
        .map((entry) => `# ${entry.title}\n\n${entry.body.trimEnd()}\n`)
        .join('\n');
      if (existsSync(files[kind]) && readFileSync(files[kind], 'utf8') === text)
        continue;
      const temporary = path.join(directory, `.${kind}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, text, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        renameSync(temporary, files[kind]);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
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
      Pick<BrowserTab, 'id' | 'conversationId' | 'title' | 'url'>
    >;
    return rows.map((row) => ({
      ...row,
      control: 'off',
      loading: false,
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
        `INSERT INTO browser_tabs(id,conversationId,title,url) VALUES (@id,@conversationId,@title,@url)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url`,
      )
      .run({
        id: tab.id,
        conversationId: tab.conversationId,
        title: tab.title,
        url: tab.url,
      });
  }
  deleteBrowserTab(id: string): void {
    this.db.prepare('DELETE FROM browser_tabs WHERE id = ?').run(id);
  }
  close(): void {
    if (this.db.open) this.db.close();
  }
}

export function createDataStore(
  dataDir: string,
  codec: SecretCodec,
): DataStore {
  return new DataStore(dataDir, codec);
}
