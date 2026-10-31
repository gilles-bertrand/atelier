/**
 * Artefacts (ADR-003 D5) : pages publiées par l'agent et leurs versions,
 * photographiées à chaque publication. Identité : projet (ou aucun) et chemin
 * canonique du fichier source ; republier le même fichier ajoute une version.
 *
 * Deux implémentations : SQLite (migration n° 5) et en mémoire (tests).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AtelierError,
  MAX_ARTIFACT_VERSIONS,
  type Artifact,
  type ArtifactFormat,
  type ArtifactVersion,
} from '@atelier/shared';

/** Publication d'une version. */
export interface ArtifactPublication {
  projectId?: string;
  /** Chemin absolu canonique du fichier source. */
  path: string;
  title: string;
  description?: string;
  format: ArtifactFormat;
  content: Uint8Array;
  sessionId?: string;
  runId?: string;
  taskName?: string;
  at: string;
}

/** Contenu d'une version, servi par le protocole `atelier-artifact:`. */
export interface ArtifactContent {
  artifact: Artifact;
  version: number;
  format: ArtifactFormat;
  content: Uint8Array;
}

export interface ArtifactStore {
  /** Crée l'artefact ou lui ajoute une version ; purge au-delà de {@link MAX_ARTIFACT_VERSIONS}. */
  publish(publication: ArtifactPublication): Artifact;
  /** Artefacts, le plus récemment publié d'abord ; `projectId` : ceux de ce projet. */
  list(projectId?: string): Artifact[];
  get(id: string): Artifact | undefined;
  /** Versions gardées, la plus récente d'abord. */
  versions(id: string): ArtifactVersion[];
  /** Contenu d'une version (`undefined` : la dernière). */
  content(id: string, version?: number): ArtifactContent | undefined;
  delete(id: string): void;
}

/** Erreur « artefact introuvable ». */
export function artifactNotFound(id: string): AtelierError {
  return new AtelierError('artifact/not_found', `Artefact introuvable : ${id}`, {
    details: { artifactId: id },
  });
}

// --- En mémoire

interface MemoryArtifact {
  artifact: Artifact;
  versions: (ArtifactVersion & { content: Uint8Array })[];
}

function provenance(p: Pick<ArtifactPublication, 'sessionId' | 'runId' | 'taskName'>): {
  sessionId?: string;
  runId?: string;
  taskName?: string;
} {
  return {
    ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
    ...(p.runId !== undefined ? { runId: p.runId } : {}),
    ...(p.taskName !== undefined ? { taskName: p.taskName } : {}),
  };
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #items = new Map<string, MemoryArtifact>();
  readonly #newId: () => string;

  constructor(newId: () => string = randomUUID) {
    this.#newId = newId;
  }

  publish(publication: ArtifactPublication): Artifact {
    const existing = [...this.#items.values()].find(
      (item) =>
        item.artifact.path === publication.path &&
        item.artifact.projectId === publication.projectId,
    );
    const version = (existing?.artifact.version ?? 0) + 1;
    const artifact: Artifact = {
      id: existing?.artifact.id ?? this.#newId(),
      ...(publication.projectId !== undefined ? { projectId: publication.projectId } : {}),
      path: publication.path,
      title: publication.title,
      ...(publication.description !== undefined ? { description: publication.description } : {}),
      format: publication.format,
      version,
      createdAt: existing?.artifact.createdAt ?? publication.at,
      updatedAt: publication.at,
      ...provenance(publication),
    };
    const versions = existing?.versions ?? [];
    versions.push({
      artifactId: artifact.id,
      version,
      size: publication.content.byteLength,
      createdAt: publication.at,
      ...provenance(publication),
      content: new Uint8Array(publication.content),
    });
    while (versions.length > MAX_ARTIFACT_VERSIONS) versions.shift();
    this.#items.set(artifact.id, { artifact, versions });
    return { ...artifact };
  }

  list(projectId?: string): Artifact[] {
    return [...this.#items.values()]
      .map((item) => item.artifact)
      .filter((a) => projectId === undefined || a.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((a) => ({ ...a }));
  }

  get(id: string): Artifact | undefined {
    const item = this.#items.get(id);
    return item ? { ...item.artifact } : undefined;
  }

  versions(id: string): ArtifactVersion[] {
    const item = this.#items.get(id);
    if (!item) throw artifactNotFound(id);
    return [...item.versions].reverse().map(({ content: _content, ...v }) => v);
  }

  content(id: string, version?: number): ArtifactContent | undefined {
    const item = this.#items.get(id);
    if (!item) return undefined;
    const wanted = version ?? item.artifact.version;
    const found = item.versions.find((v) => v.version === wanted);
    return found
      ? {
          artifact: { ...item.artifact },
          version: found.version,
          format: item.artifact.format,
          content: found.content,
        }
      : undefined;
  }

  delete(id: string): void {
    this.#items.delete(id);
  }

  /** Projet supprimé : ses artefacts suivent (cascade de la version SQLite). */
  deleteProject(projectId: string): void {
    for (const [id, item] of this.#items) {
      if (item.artifact.projectId === projectId) this.#items.delete(id);
    }
  }
}

// --- SQLite

interface ArtifactRow {
  id: string;
  project_id: string | null;
  path: string;
  title: string;
  description: string | null;
  format: string;
  version: number;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  run_id: string | null;
  task_name: string | null;
}

interface VersionRow {
  artifact_id: string;
  version: number;
  size: number;
  session_id: string | null;
  run_id: string | null;
  task_name: string | null;
  created_at: string;
}

function toFormat(value: string): ArtifactFormat {
  return value === 'markdown' ? 'markdown' : 'html';
}

function rowProvenance(row: Pick<VersionRow, 'session_id' | 'run_id' | 'task_name'>): {
  sessionId?: string;
  runId?: string;
  taskName?: string;
} {
  return {
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.task_name !== null ? { taskName: row.task_name } : {}),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    path: row.path,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    format: toFormat(row.format),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...rowProvenance(row),
  };
}

/** Artefact et provenance de sa dernière version (jointure). */
const SELECT_ARTIFACT = `SELECT a.*, v.session_id, v.run_id, v.task_name
  FROM artifacts a
  LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.version`;

export class SqliteArtifactStore implements ArtifactStore {
  readonly #db: DatabaseSync;
  readonly #newId: () => string;

  constructor(db: DatabaseSync, newId: () => string = randomUUID) {
    this.#db = db;
    this.#newId = newId;
  }

  publish(publication: ArtifactPublication): Artifact {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#db
        .prepare(
          `SELECT id, version, created_at FROM artifacts
           WHERE COALESCE(project_id, '') = ? AND path = ?`,
        )
        .get(publication.projectId ?? '', publication.path) as
        { id: string; version: number; created_at: string } | undefined;
      const id = existing?.id ?? this.#newId();
      const version = (existing?.version ?? 0) + 1;
      if (existing) {
        this.#db
          .prepare(
            `UPDATE artifacts SET title = ?, description = ?, format = ?, version = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            publication.title,
            publication.description ?? null,
            publication.format,
            version,
            publication.at,
            id,
          );
      } else {
        this.#db
          .prepare(
            `INSERT INTO artifacts (id, project_id, path, title, description, format, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            publication.projectId ?? null,
            publication.path,
            publication.title,
            publication.description ?? null,
            publication.format,
            version,
            publication.at,
            publication.at,
          );
      }
      this.#db
        .prepare(
          `INSERT INTO artifact_versions (artifact_id, version, content, size, session_id, run_id, task_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          version,
          publication.content,
          publication.content.byteLength,
          publication.sessionId ?? null,
          publication.runId ?? null,
          publication.taskName ?? null,
          publication.at,
        );
      this.#db
        .prepare('DELETE FROM artifact_versions WHERE artifact_id = ? AND version <= ?')
        .run(id, version - MAX_ARTIFACT_VERSIONS);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const artifact = this.#find(publication.projectId, publication.path);
    if (!artifact) throw artifactNotFound(publication.path);
    return artifact;
  }

  list(projectId?: string): Artifact[] {
    const where = projectId === undefined ? '' : 'WHERE a.project_id = ?';
    const statement = this.#db.prepare(
      `${SELECT_ARTIFACT} ${where} ORDER BY a.updated_at DESC, a.rowid DESC`,
    );
    const rows = (projectId === undefined
      ? statement.all()
      : statement.all(projectId)) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  get(id: string): Artifact | undefined {
    const row = this.#db.prepare(`${SELECT_ARTIFACT} WHERE a.id = ?`).get(id) as
      ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }

  versions(id: string): ArtifactVersion[] {
    if (!this.get(id)) throw artifactNotFound(id);
    const rows = this.#db
      .prepare(
        `SELECT artifact_id, version, size, session_id, run_id, task_name, created_at
         FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`,
      )
      .all(id) as unknown as VersionRow[];
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      version: row.version,
      size: row.size,
      createdAt: row.created_at,
      ...rowProvenance(row),
    }));
  }

  content(id: string, version?: number): ArtifactContent | undefined {
    const artifact = this.get(id);
    if (!artifact) return undefined;
    const wanted = version ?? artifact.version;
    const row = this.#db
      .prepare('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(id, wanted) as { content: Uint8Array } | undefined;
    return row
      ? { artifact, version: wanted, format: artifact.format, content: row.content }
      : undefined;
  }

  delete(id: string): void {
    this.#db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  }

  #find(projectId: string | undefined, path: string): Artifact | undefined {
    const row = this.#db
      .prepare(`${SELECT_ARTIFACT} WHERE COALESCE(a.project_id, '') = ? AND a.path = ?`)
      .get(projectId ?? '', path) as ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }
}
