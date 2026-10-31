/**
 * Projets (ADR-003) : identité, dossiers, consignes et mémoire versionnée.
 *
 * Deux implémentations : SQLite (migration n° 5, `userData/atelier.db`) et en
 * mémoire (tests, base inutilisable). Ce module ne fait aucune vérification
 * sur le disque : c'est le rôle de `ProjectService`.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  AtelierError,
  MAX_MEMORY_REVISIONS,
  type MemoryRevision,
  type MemorySource,
  type Project,
  type ProjectFolder,
  type ProjectMemory,
  type ProjectSummary,
} from '@atelier/shared';

/** Champs enregistrés d'un projet (dossiers déjà validés). */
export type StoredProject = Omit<Project, 'archivedAt'> & { archivedAt?: string };

/** Nouvelle révision de la mémoire. */
export interface MemoryWrite {
  content: string;
  source: MemorySource;
  /** Révision lue par l'auteur ; absente : écriture sans contrôle (l'agent ajoute à la dernière). */
  baseRevision?: number;
  sessionId?: string;
  runId?: string;
  at: string;
}

export interface ProjectStore {
  /** Projets du plus récemment actif au plus ancien, avec leurs compteurs. */
  list(options?: { includeArchived?: boolean }): ProjectSummary[];
  get(id: string): Project | undefined;
  /** Crée ou remplace (même `id`) un projet et ses dossiers. */
  save(project: StoredProject): Project;
  /** Supprime le projet ; conversations, tâches, mémoire et artefacts suivent en cascade. */
  delete(id: string): void;
  memory(id: string): ProjectMemory;
  /**
   * Ajoute une révision. Rejette `project/conflict` si `baseRevision` n'est plus
   * la dernière. Garde {@link MAX_MEMORY_REVISIONS} révisions, la première comprise.
   */
  writeMemory(id: string, write: MemoryWrite): ProjectMemory;
  /** Révisions, la plus récente d'abord. */
  memoryHistory(id: string, limit?: number): MemoryRevision[];
}

/** Erreur « projet introuvable ». */
export function projectNotFound(id: string): AtelierError {
  return new AtelierError('project/not_found', `Projet introuvable : ${id}`, {
    details: { projectId: id },
  });
}

function conflict(id: string, base: number, current: number): AtelierError {
  return new AtelierError('project/conflict', 'La mémoire du projet a changé depuis sa lecture.', {
    details: { projectId: id, baseRevision: base, revision: current },
  });
}

// --- En mémoire

interface MemoryState {
  revisions: MemoryRevision[];
}

export class InMemoryProjectStore implements ProjectStore {
  readonly #projects = new Map<string, StoredProject>();
  readonly #memory = new Map<string, MemoryState>();
  /** Compteurs fournis par l'app (conversations, tâches, artefacts) : tests. */
  readonly #counts: (id: string) => Omit<ProjectSummary, keyof Project>;

  constructor(
    counts: (id: string) => Omit<ProjectSummary, keyof Project> = () => ({
      conversations: 0,
      tasks: 0,
      artifacts: 0,
    }),
  ) {
    this.#counts = counts;
  }

  list(options: { includeArchived?: boolean } = {}): ProjectSummary[] {
    return [...this.#projects.values()]
      .filter((p) => options.includeArchived === true || p.archivedAt === undefined)
      .map((p) => ({ ...clone(p), ...this.#counts(p.id) }))
      .sort((a, b) =>
        (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt),
      );
  }

  get(id: string): Project | undefined {
    const project = this.#projects.get(id);
    return project ? clone(project) : undefined;
  }

  save(project: StoredProject): Project {
    this.#projects.set(project.id, clone(project));
    return clone(project);
  }

  delete(id: string): void {
    this.#projects.delete(id);
    this.#memory.delete(id);
  }

  memory(id: string): ProjectMemory {
    if (!this.#projects.has(id)) throw projectNotFound(id);
    const last = this.#memory.get(id)?.revisions.at(-1);
    return last
      ? { content: last.content, revision: last.revision, updatedAt: last.createdAt }
      : { content: '', revision: 0 };
  }

  writeMemory(id: string, write: MemoryWrite): ProjectMemory {
    if (!this.#projects.has(id)) throw projectNotFound(id);
    const state = this.#memory.get(id) ?? { revisions: [] };
    const current = state.revisions.at(-1)?.revision ?? 0;
    if (write.baseRevision !== undefined && write.baseRevision !== current) {
      throw conflict(id, write.baseRevision, current);
    }
    const revision: MemoryRevision = {
      revision: current + 1,
      content: write.content,
      source: write.source,
      ...(write.sessionId !== undefined ? { sessionId: write.sessionId } : {}),
      ...(write.runId !== undefined ? { runId: write.runId } : {}),
      createdAt: write.at,
    };
    state.revisions.push(revision);
    if (state.revisions.length > MAX_MEMORY_REVISIONS) {
      // La première révision reste : c'est l'origine de la mémoire.
      state.revisions.splice(1, state.revisions.length - MAX_MEMORY_REVISIONS);
    }
    this.#memory.set(id, state);
    return { content: revision.content, revision: revision.revision, updatedAt: write.at };
  }

  memoryHistory(id: string, limit = 50): MemoryRevision[] {
    if (!this.#projects.has(id)) throw projectNotFound(id);
    return [...(this.#memory.get(id)?.revisions ?? [])].reverse().slice(0, limit);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// --- SQLite

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface FolderRow {
  project_id: string;
  position: number;
  path: string;
  label: string;
  access: string;
}

interface RevisionRow {
  revision: number;
  content: string;
  source: string;
  session_id: string | null;
  run_id: string | null;
  created_at: string;
}

interface SummaryRow extends ProjectRow {
  conversations: number;
  tasks: number;
  artifacts: number;
  last_activity_at: string | null;
}

function toFolder(row: FolderRow): ProjectFolder {
  return { path: row.path, label: row.label, access: row.access === 'read' ? 'read' : 'write' };
}

function toRevision(row: RevisionRow): MemoryRevision {
  return {
    revision: row.revision,
    content: row.content,
    source: row.source === 'agent' ? 'agent' : 'user',
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
  };
}

export class SqliteProjectStore implements ProjectStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(options: { includeArchived?: boolean } = {}): ProjectSummary[] {
    const where = options.includeArchived === true ? '' : 'WHERE p.archived_at IS NULL';
    const rows = this.#db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM sessions s
              WHERE s.project_id = p.id AND s.scheduled_task_id IS NULL) AS conversations,
           (SELECT COUNT(*) FROM scheduled_tasks t WHERE t.project_id = p.id) AS tasks,
           (SELECT COUNT(*) FROM artifacts a WHERE a.project_id = p.id) AS artifacts,
           (SELECT MAX(s.updated_at) FROM sessions s WHERE s.project_id = p.id) AS last_activity_at
         FROM projects p ${where}
         ORDER BY COALESCE(last_activity_at, p.updated_at) DESC, p.rowid DESC`,
      )
      .all() as unknown as SummaryRow[];
    const folders = this.#allFolders();
    return rows.map((row) => ({
      ...this.#toProject(row, folders.get(row.id) ?? []),
      conversations: row.conversations,
      tasks: row.tasks,
      artifacts: row.artifacts,
      ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    }));
  }

  get(id: string): Project | undefined {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    if (!row) return undefined;
    const folders = this.#db
      .prepare('SELECT * FROM project_folders WHERE project_id = ? ORDER BY position')
      .all(id) as unknown as FolderRow[];
    return this.#toProject(row, folders.map(toFolder));
  }

  save(project: StoredProject): Project {
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          `INSERT INTO projects (id, name, description, instructions, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name, description = excluded.description,
             instructions = excluded.instructions, updated_at = excluded.updated_at,
             archived_at = excluded.archived_at`,
        )
        .run(
          project.id,
          project.name,
          project.description,
          project.instructions,
          project.createdAt,
          project.updatedAt,
          project.archivedAt ?? null,
        );
      this.#db.prepare('DELETE FROM project_folders WHERE project_id = ?').run(project.id);
      const insert = this.#db.prepare(
        `INSERT INTO project_folders (project_id, position, path, label, access)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [position, folder] of project.folders.entries()) {
        insert.run(project.id, position, folder.path, folder.label, folder.access);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const saved = this.get(project.id);
    if (!saved) throw projectNotFound(project.id);
    return saved;
  }

  delete(id: string): void {
    // Dossiers, mémoire, conversations (et leurs messages), tâches (et leurs runs)
    // et artefacts (et leurs versions) sont supprimés en cascade.
    this.#db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  memory(id: string): ProjectMemory {
    this.#assertExists(id);
    const row = this.#db
      .prepare(
        `SELECT revision, content, created_at FROM project_memory_revisions
         WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(id) as Pick<RevisionRow, 'revision' | 'content' | 'created_at'> | undefined;
    return row
      ? { content: row.content, revision: row.revision, updatedAt: row.created_at }
      : { content: '', revision: 0 };
  }

  writeMemory(id: string, write: MemoryWrite): ProjectMemory {
    this.#assertExists(id);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.memory(id).revision;
      if (write.baseRevision !== undefined && write.baseRevision !== current) {
        throw conflict(id, write.baseRevision, current);
      }
      const revision = current + 1;
      this.#db
        .prepare(
          `INSERT INTO project_memory_revisions
             (project_id, revision, content, source, session_id, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          revision,
          write.content,
          write.source,
          write.sessionId ?? null,
          write.runId ?? null,
          write.at,
        );
      // Purge : garde la première révision et les plus récentes.
      this.#db
        .prepare(
          `DELETE FROM project_memory_revisions
           WHERE project_id = ? AND revision > (SELECT MIN(revision) FROM project_memory_revisions WHERE project_id = ?)
             AND revision <= ? - ?`,
        )
        .run(id, id, revision, MAX_MEMORY_REVISIONS - 1);
      this.#db.exec('COMMIT');
      return { content: write.content, revision, updatedAt: write.at };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  memoryHistory(id: string, limit = 50): MemoryRevision[] {
    this.#assertExists(id);
    const rows = this.#db
      .prepare(
        `SELECT * FROM project_memory_revisions WHERE project_id = ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, limit) as unknown as RevisionRow[];
    return rows.map(toRevision);
  }

  #assertExists(id: string): void {
    const row = this.#db.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(id);
    if (!row) throw projectNotFound(id);
  }

  #allFolders(): Map<string, ProjectFolder[]> {
    const rows = this.#db
      .prepare('SELECT * FROM project_folders ORDER BY project_id, position')
      .all() as unknown as FolderRow[];
    const map = new Map<string, ProjectFolder[]>();
    for (const row of rows) {
      const list = map.get(row.project_id) ?? [];
      list.push(toFolder(row));
      map.set(row.project_id, list);
    }
    return map;
  }

  #toProject(row: ProjectRow, folders: ProjectFolder[]): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      folders,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    };
  }
}
