/**
 * Historique persistant des conversations (SQLite via `node:sqlite`, intégré à
 * Node 22.13+ et à Electron : aucun module natif à compiler ni à signer).
 *
 * Fichier `userData/atelier.db`, mode WAL, clés étrangères, migrations
 * versionnées par `PRAGMA user_version`. On stocke les messages affichés
 * (`ChatMessage`, JSON) et l'historique modèle (`TurnResult.messages`, JSON).
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, MessagePart, SessionSummary } from '@atelier/shared';
import type { ModelMessage } from 'ai';
import { sessionNotFound, type SessionStore } from './session-store.js';

/** Migrations successives : l'index + 1 est la version atteinte. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     workspace TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX sessions_updated ON sessions (updated_at DESC);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     parts TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX messages_session ON messages (session_id, seq);
   CREATE TABLE model_history (
     session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
     messages TEXT NOT NULL
   );`,
  // 2 : registre de consommation, une ligne par tour (ADR-001, voir `usage-store.ts`).
  // Les statistiques survivent à la suppression des conversations (SET NULL).
  `CREATE TABLE usage_turns (
     turn_id TEXT PRIMARY KEY,
     session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
     model TEXT NOT NULL,
     outcome TEXT NOT NULL,
     day TEXT NOT NULL,
     steps INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     context_tokens INTEGER,
     context_window INTEGER,
     generation_ms INTEGER NOT NULL,
     compactions INTEGER NOT NULL,
     relaunches TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   );
   CREATE INDEX usage_turns_day ON usage_turns (day);
   CREATE INDEX usage_turns_session ON usage_turns (session_id);`,
];

/** Version de schéma courante. */
export const SCHEMA_VERSION = MIGRATIONS.length;

let warningFilterInstalled = false;

/**
 * `node:sqlite` émet un `ExperimentalWarning` au chargement : on masque CE seul
 * avertissement (les autres continuent d'être affichés).
 */
function silenceSqliteWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process) as unknown as (...args: unknown[]) => void;
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === 'string' ? warning : warning.message;
    const first = rest[0];
    const type =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'type' in first
          ? String((first as { type?: unknown }).type)
          : warning instanceof Error
            ? warning.name
            : undefined;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    original(warning, ...rest);
  };
  process.emitWarning = filtered;
}

/** Ouvre (et migre) la base ; `:memory:` pour les tests. */
export async function openDatabase(file: string): Promise<DatabaseSync> {
  silenceSqliteWarning();
  const { DatabaseSync: Database } = await import('node:sqlite');
  if (file !== ':memory:') await mkdir(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  migrate(db);
  return db;
}

/** Applique les migrations manquantes, chacune dans une transaction. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Base d'historique plus récente que l'application (schéma ${String(current)}) : mettez Atelier à jour.`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] ?? '');
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  parts: string;
  created_at: string;
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parties d'un message relu ; une ligne corrompue devient un message vide plutôt qu'un crash. */
function parseParts(json: string): MessagePart[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}

export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(file: string): Promise<SqliteSessionStore> {
    return new SqliteSessionStore(await openDatabase(file));
  }

  list(limit = 50): SessionSummary[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(limit) as unknown as SessionRow[];
    return rows.map(toSummary);
  }

  get(sessionId: string): SessionSummary | undefined {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      SessionRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  create(session: SessionSummary): SessionSummary {
    this.#db
      .prepare(
        'INSERT INTO sessions (id, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(session.id, session.title, session.workspace, session.createdAt, session.updatedAt);
    return session;
  }

  update(
    sessionId: string,
    patch: Partial<Pick<SessionSummary, 'title' | 'updatedAt'>>,
  ): SessionSummary {
    const current = this.get(sessionId);
    if (!current) throw sessionNotFound(sessionId);
    const next = { ...current, ...patch };
    this.#db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.updatedAt, sessionId);
    return next;
  }

  delete(sessionId: string): void {
    // Messages et historique modèle supprimés en cascade.
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  messages(sessionId: string): ChatMessage[] {
    const rows = this.#db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      parts: parseParts(row.parts),
      createdAt: row.created_at,
    }));
  }

  saveMessage(message: ChatMessage): void {
    if (!this.get(message.sessionId)) throw sessionNotFound(message.sessionId);
    this.#db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, parts, created_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET parts = excluded.parts`,
      )
      .run(
        message.id,
        message.sessionId,
        message.sessionId,
        message.role,
        JSON.stringify(message.parts),
        message.createdAt,
      );
  }

  modelHistory(sessionId: string): readonly ModelMessage[] | undefined {
    const row = this.#db
      .prepare('SELECT messages FROM model_history WHERE session_id = ?')
      .get(sessionId) as { messages: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.messages);
      return Array.isArray(parsed) ? (parsed as ModelMessage[]) : undefined;
    } catch {
      // Historique illisible : repli sur la reconstruction depuis l'affichage.
      return undefined;
    }
  }

  saveModelHistory(sessionId: string, messages: readonly ModelMessage[]): void {
    if (!this.get(sessionId)) throw sessionNotFound(sessionId);
    this.#db
      .prepare(
        `INSERT INTO model_history (session_id, messages) VALUES (?, ?)
         ON CONFLICT (session_id) DO UPDATE SET messages = excluded.messages`,
      )
      .run(sessionId, JSON.stringify(messages));
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
