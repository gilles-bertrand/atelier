/**
 * Projets côté main (ADR-003) : règles des dossiers, dossier créé pour un
 * nouveau projet, mémoire versionnée, artefacts, et tout ce dont une
 * conversation de projet a besoin à chaque tour (dossiers rattachés, montages,
 * contexte du prompt, outils de mémoire et de publication).
 *
 * Les dépendances qui naissent après le service (conversations, tâches) sont
 * branchées par des fonctions : aucune dépendance circulaire à la construction.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendMemoryNote,
  createMemoryTools,
  createPublishArtifactTool,
  MAX_PROMPT_ARTIFACTS,
  type ArtifactPublisher,
  type ArtifactPublishRequest,
  type ProjectMemoryWriter,
  type PromptProject,
} from '@atelier/agent-core';
import {
  AtelierError,
  defaultFolderLabel,
  isAtelierError,
  isSameOrInside,
  MAX_MEMORY_CHARS,
  projectDirName,
  validateProjectInput,
  type AnyToolDefinition,
  type Artifact,
  type ArtifactCard,
  type ArtifactVersion,
  type MemoryRevision,
  type Project,
  type ProjectFolder,
  type ProjectInput,
  type ProjectMemory,
  type ProjectSummary,
  type ProjectValidationIssue,
  type ScheduledTask,
  type SessionSummary,
  type WorkspaceFolder,
} from '@atelier/shared';
import type { SessionStore } from '../runtime/session-store.js';
import { assertWorkspace } from '../workspace-rules.js';
import { artifactNotFound, type ArtifactStore } from './artifact-store.js';
import { attachedFolders, displayPath, mountSignature } from './project-mounts.js';
import { projectNotFound, type ProjectStore, type StoredProject } from './project-store.js';

/** Tâches planifiées vues par les projets (archivage, suppression, dossier principal changé). */
export interface ProjectTasks {
  list(): ScheduledTask[];
  setEnabled(id: string, enabled: boolean): unknown;
  delete(id: string): Promise<void>;
  /** La tâche suit le nouveau dossier principal de son projet. */
  retarget(id: string, workspace: string): unknown;
}

export interface ProjectServiceOptions {
  store: ProjectStore;
  artifacts: ArtifactStore;
  sessions: SessionStore;
  /** Racine des dossiers créés pour les projets (`AppSettings.projectsDir`, D2). */
  projectsDir: () => string;
  home: string;
  /** Dossiers que l'agent ne doit jamais toucher : données de la VM, skills. */
  forbiddenRoots?: () => readonly string[];
  /** Supprime une conversation en arrêtant son tour (`ChatManager.delete`). */
  deleteSession?: (sessionId: string) => Promise<void>;
  /** Tâches planifiées, branchées après la création du scheduler. */
  tasks?: () => ProjectTasks | undefined;
  /** Run planifié en cours d'une conversation (provenance de la mémoire et des artefacts). */
  runOf?: (sessionId: string) => { runId: string; taskName: string } | undefined;
  onProjectChanged?: (projectId: string) => void;
  onArtifactChanged?: (artifact: Artifact, deleted?: boolean) => void;
  now?: () => Date;
  newId?: () => string;
}

/** Ce qu'une conversation de projet utilise à chaque tour (`ChatManager`). */
export interface ProjectTurn {
  /** Nom du projet (bail de la VM, Composer). */
  name: string;
  /** Dossiers rattachés, avec leur point de montage. */
  folders: WorkspaceFolder[];
  /** Signature des montages : deux tours de même signature partagent la VM. */
  mounts: string;
}

/** Projet refusé : message français affiché tel quel par le renderer. */
function invalid(issue: ProjectValidationIssue): AtelierError {
  return new AtelierError('project/invalid', issue.message, {
    details: { field: issue.field, ...(issue.index !== undefined ? { index: issue.index } : {}) },
  });
}

/** Dossiers créés pour un même nom au plus (« Ventes », « Ventes 2 »…). */
const MAX_HOME_SUFFIX = 99;

export class ProjectService implements ProjectMemoryWriter, ArtifactPublisher {
  readonly #o: ProjectServiceOptions;
  #tools: { memory: AnyToolDefinition[]; publish: AnyToolDefinition } | undefined;

  constructor(options: ProjectServiceOptions) {
    this.#o = options;
  }

  // --- Projets

  list(includeArchived = false): ProjectSummary[] {
    return this.#o.store.list({ includeArchived });
  }

  get(id: string): Project {
    const project = this.#o.store.get(id);
    if (!project) throw projectNotFound(id);
    return project;
  }

  /** Crée un projet ; sans dossiers, crée `<projectsDir>/<nom>/` comme dossier principal. */
  async create(input: ProjectInput): Promise<Project> {
    const fields = this.#fields(input);
    const issue = validateProjectInput(fields);
    if (issue) throw invalid(issue);
    const folders =
      input.folders && input.folders.length > 0
        ? await this.#normalizeFolders(input.folders)
        : [await this.#createHome(fields.name)];
    const at = this.#now();
    return this.#save({ id: this.#id(), ...fields, folders, createdAt: at, updatedAt: at });
  }

  /** Les champs présents remplacent ceux du projet ; `folders` remplace toute la liste. */
  async update(id: string, patch: Partial<ProjectInput>): Promise<Project> {
    const current = this.get(id);
    const fields = this.#fields({
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      instructions: patch.instructions ?? current.instructions,
    });
    const folders =
      patch.folders !== undefined ? await this.#normalizeFolders(patch.folders) : current.folders;
    const project = this.#save({ ...current, ...fields, folders, updatedAt: this.#now() });
    const previous = current.folders[0]?.path;
    const primary = project.folders[0]?.path;
    if (primary !== undefined && primary !== previous) this.#retarget(project.id, primary);
    return project;
  }

  /** Archiver masque le projet et désactive ses tâches ; désarchiver ne les réactive pas. */
  setArchived(id: string, archived: boolean): Project {
    const current = this.get(id);
    const { archivedAt: _previous, ...rest } = current;
    const project = this.#save({
      ...rest,
      ...(archived ? { archivedAt: current.archivedAt ?? this.#now() } : {}),
      updatedAt: this.#now(),
    });
    if (archived) {
      const tasks = this.#o.tasks?.();
      for (const task of tasks?.list() ?? []) {
        if (task.projectId === id && task.enabled) tasks?.setEnabled(task.id, false);
      }
    }
    return project;
  }

  /**
   * Retire le projet de l'app : ses conversations (tours arrêtés), ses tâches,
   * sa mémoire et l'historique de ses artefacts. Aucun fichier n'est supprimé.
   */
  async delete(id: string): Promise<void> {
    this.get(id);
    const sessions = this.#o.sessions.list(Number.MAX_SAFE_INTEGER, {
      includeScheduled: true,
      projectId: id,
    });
    for (const session of sessions) {
      if (this.#o.deleteSession) await this.#o.deleteSession(session.id);
      else this.#o.sessions.delete(session.id);
    }
    const tasks = this.#o.tasks?.();
    for (const task of tasks?.list() ?? []) {
      if (task.projectId === id) await tasks?.delete(task.id);
    }
    for (const artifact of this.#o.artifacts.list(id)) this.#o.artifacts.delete(artifact.id);
    this.#o.store.delete(id);
    this.#o.onProjectChanged?.(id);
  }

  /**
   * Projet dont le dossier principal est `workspace` ; les conversations hors
   * projet de ce dossier le rejoignent. `name` absent : nom du dossier.
   */
  async fromFolder(workspace: string, name?: string): Promise<Project> {
    const dir = await realpath(await assertWorkspace(workspace, this.#o.home));
    const label = defaultFolderLabel(dir);
    const project = await this.create({
      name: name?.trim() || label,
      folders: [{ path: dir, label, access: 'write' }],
    });
    for (const session of this.#o.sessions.list(Number.MAX_SAFE_INTEGER)) {
      if (session.projectId !== undefined) continue;
      if (session.workspace !== workspace && (await canonical(session.workspace)) !== dir) {
        continue;
      }
      this.#o.sessions.update(session.id, { projectId: project.id, workspace: dir });
    }
    this.#o.onProjectChanged?.(project.id);
    return project;
  }

  /** Dossier principal d'un projet (conversation ou tâche de ce projet). */
  primaryOf(projectId: string): string {
    const primary = this.get(projectId).folders[0]?.path;
    if (primary === undefined) throw projectNotFound(projectId);
    return primary;
  }

  /** Dossiers de tous les projets : lieux ouvrables et prévisualisables. */
  openableRoots(): string[] {
    return this.#o.store
      .list({ includeArchived: true })
      .flatMap((project) => project.folders.map((f) => f.path));
  }

  // --- Mémoire

  memory(id: string): ProjectMemory {
    return this.#o.store.memory(id);
  }

  /** Édition par l'utilisateur ; `project/conflict` si la mémoire a changé depuis `baseRevision`. */
  saveMemory(id: string, content: string, baseRevision: number): ProjectMemory {
    this.#assertMemorySize(content);
    const memory = this.#o.store.writeMemory(id, {
      content,
      source: 'user',
      baseRevision,
      at: this.#now(),
    });
    this.#o.onProjectChanged?.(id);
    return memory;
  }

  memoryHistory(id: string, limit?: number): MemoryRevision[] {
    return this.#o.store.memoryHistory(id, limit);
  }

  /** `memory_add` : note datée sous « Notes », sur la dernière révision. */
  // eslint-disable-next-line @typescript-eslint/require-await -- contrat asynchrone (erreurs en rejet)
  async append(sessionId: string, note: string): Promise<{ content: string; revision: number }> {
    const projectId = this.#projectOfSession(sessionId);
    const current = this.#o.store.memory(projectId);
    const content = appendMemoryNote(current.content, note, new Date(this.#now()));
    return this.#agentWrite(projectId, sessionId, content);
  }

  /** `memory_rewrite` : remplace toute la mémoire. */
  // eslint-disable-next-line @typescript-eslint/require-await -- contrat asynchrone (erreurs en rejet)
  async rewrite(
    sessionId: string,
    content: string,
  ): Promise<{ content: string; revision: number }> {
    const projectId = this.#projectOfSession(sessionId);
    return this.#agentWrite(projectId, sessionId, content);
  }

  // --- Artefacts

  /** `publish_artifact` : nouvelle version (ou nouvel artefact), provenance comprise. */
  // eslint-disable-next-line @typescript-eslint/require-await -- contrat asynchrone (erreurs en rejet)
  async publish(request: ArtifactPublishRequest): Promise<ArtifactCard> {
    const session = this.#o.sessions.get(request.sessionId);
    const run = this.#o.runOf?.(request.sessionId);
    const artifact = this.#o.artifacts.publish({
      ...(session?.projectId !== undefined ? { projectId: session.projectId } : {}),
      path: request.path,
      title: request.title,
      ...(request.description !== undefined ? { description: request.description } : {}),
      format: request.format,
      content: request.content,
      sessionId: request.sessionId,
      ...(run ? { runId: run.runId, taskName: run.taskName } : {}),
      at: this.#now(),
    });
    this.#o.onArtifactChanged?.(artifact);
    return {
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      format: artifact.format,
      path: artifact.path,
    };
  }

  listArtifacts(projectId?: string): Artifact[] {
    return this.#o.artifacts.list(projectId);
  }

  getArtifact(id: string): Artifact {
    const artifact = this.#o.artifacts.get(id);
    if (!artifact) throw artifactNotFound(id);
    return artifact;
  }

  artifactVersions(id: string): ArtifactVersion[] {
    return this.#o.artifacts.versions(id);
  }

  /** Retire l'artefact de l'app ; le fichier source reste sur le disque. */
  deleteArtifact(id: string): void {
    const artifact = this.getArtifact(id);
    this.#o.artifacts.delete(id);
    this.#o.onArtifactChanged?.(artifact, true);
  }

  // --- Conversations de projet

  /** Dossiers rattachés et montages d'une conversation pour ce tour ; `undefined` hors projet. */
  turnFor(session: SessionSummary): ProjectTurn | undefined {
    if (session.projectId === undefined) return undefined;
    const project = this.#o.store.get(session.projectId);
    if (!project) return undefined;
    const folders = attachedFolders(project).filter((f) => f.path !== session.workspace);
    return { name: project.name, folders, mounts: mountSignature(session.workspace, folders) };
  }

  /** Bail d'un run planifié de projet : mêmes montages que les conversations du projet. */
  leaseFor(task: ScheduledTask): { projectName: string; mounts: string } | undefined {
    if (task.projectId === undefined) return undefined;
    const project = this.#o.store.get(task.projectId);
    const primary = project?.folders[0]?.path;
    if (!project || primary === undefined) return undefined;
    return { projectName: project.name, mounts: mountSignature(primary, attachedFolders(project)) };
  }

  /** Contexte du prompt, relu par l'agent au début de chaque tour. */
  promptProject(sessionId: string): () => Promise<PromptProject | undefined> {
    return () => {
      const session = this.#o.sessions.get(sessionId);
      if (session?.projectId === undefined) return Promise.resolve(undefined);
      const project = this.#o.store.get(session.projectId);
      if (!project) return Promise.resolve(undefined);
      const memory = this.#o.store.memory(project.id).content;
      const artifacts = this.#o.artifacts
        .list(project.id)
        .slice(0, MAX_PROMPT_ARTIFACTS)
        .map((a) => ({ title: a.title, path: displayPath(project, a.path), version: a.version }));
      return Promise.resolve({
        name: project.name,
        folders: attachedFolders(project).filter((f) => f.path !== session.workspace),
        ...(project.instructions !== '' ? { instructions: project.instructions } : {}),
        ...(memory !== '' ? { memory } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
    };
  }

  /**
   * Outils de la conversation : publication toujours, mémoire pour un projet
   * (sauf `memory: false`, run dont la tâche ne coche pas la mémoire).
   */
  sessionTools(session: SessionSummary, options: { memory?: boolean } = {}): AnyToolDefinition[] {
    this.#tools ??= {
      memory: createMemoryTools(this),
      publish: createPublishArtifactTool(this),
    };
    return session.projectId !== undefined && options.memory !== false
      ? [...this.#tools.memory, this.#tools.publish]
      : [this.#tools.publish];
  }

  // --- Interne

  #fields(input: Pick<ProjectInput, 'name' | 'description' | 'instructions'>): {
    name: string;
    description: string;
    instructions: string;
  } {
    return {
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      instructions: input.instructions?.trim() ?? '',
    };
  }

  #save(project: StoredProject): Project {
    const issue = validateProjectInput(project);
    if (issue) throw invalid(issue);
    const saved = this.#o.store.save(project);
    this.#o.onProjectChanged?.(saved.id);
    return saved;
  }

  /** Dossiers existants, canoniques, hors des dossiers interdits ; libellé par défaut. */
  async #normalizeFolders(folders: readonly ProjectFolder[]): Promise<ProjectFolder[]> {
    const normalized: ProjectFolder[] = [];
    for (const [index, folder] of folders.entries()) {
      let dir: string;
      try {
        dir = await realpath(await assertWorkspace(folder.path, this.#o.home));
      } catch (error) {
        throw invalid({
          field: 'folders',
          index,
          message: isAtelierError(error) ? error.message : `Dossier introuvable : ${folder.path}`,
        });
      }
      for (const root of this.#o.forbiddenRoots?.() ?? []) {
        if (isSameOrInside(root, dir) || isSameOrInside(dir, root)) {
          throw invalid({
            field: 'folders',
            index,
            message: `Le dossier ${dir} contient des données internes d’Atelier (machine isolée, skills) : choisissez-en un autre.`,
          });
        }
      }
      const label = folder.label.trim() || defaultFolderLabel(dir);
      normalized.push({ path: dir, label, access: folder.access === 'read' ? 'read' : 'write' });
    }
    return normalized;
  }

  /** Crée `<projectsDir>/<nom>` (« Ventes », sinon « Ventes 2 »…), dossier principal du projet. */
  async #createHome(name: string): Promise<ProjectFolder> {
    const root = this.#o.projectsDir();
    const base = projectDirName(name);
    for (let n = 1; n <= MAX_HOME_SUFFIX; n += 1) {
      const dir = join(root, n === 1 ? base : `${base} ${String(n)}`);
      if (await exists(dir)) continue;
      await mkdir(dir, { recursive: true });
      const path = await realpath(dir);
      return { path, label: defaultFolderLabel(path), access: 'write' };
    }
    throw invalid({
      field: 'name',
      message: `Trop de dossiers « ${base} » existent déjà dans ${root} : choisissez un autre nom.`,
    });
  }

  /** Nouveau dossier principal : les conversations et les tâches du projet le suivent. */
  #retarget(projectId: string, primary: string): void {
    const sessions = this.#o.sessions.list(Number.MAX_SAFE_INTEGER, {
      includeScheduled: true,
      projectId,
    });
    for (const session of sessions) this.#o.sessions.update(session.id, { workspace: primary });
    const tasks = this.#o.tasks?.();
    for (const task of tasks?.list() ?? []) {
      if (task.projectId === projectId) tasks?.retarget(task.id, primary);
    }
  }

  #projectOfSession(sessionId: string): string {
    const projectId = this.#o.sessions.get(sessionId)?.projectId;
    if (projectId === undefined || !this.#o.store.get(projectId)) {
      throw new AtelierError(
        'project/not_found',
        'Cette conversation n’appartient à aucun projet : il n’y a pas de mémoire où écrire.',
        { details: { sessionId } },
      );
    }
    return projectId;
  }

  #agentWrite(
    projectId: string,
    sessionId: string,
    content: string,
  ): { content: string; revision: number } {
    this.#assertMemorySize(content);
    const run = this.#o.runOf?.(sessionId);
    const memory = this.#o.store.writeMemory(projectId, {
      content,
      source: 'agent',
      sessionId,
      ...(run ? { runId: run.runId } : {}),
      at: this.#now(),
    });
    this.#o.onProjectChanged?.(projectId);
    return { content: memory.content, revision: memory.revision };
  }

  #assertMemorySize(content: string): void {
    if (content.length > MAX_MEMORY_CHARS) {
      throw new AtelierError(
        'project/invalid',
        `La mémoire dépasserait ${String(MAX_MEMORY_CHARS)} caractères : faites d’abord le tri.`,
        { details: { field: 'memory' } },
      );
    }
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  #id(): string {
    return (this.#o.newId ?? randomUUID)();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Chemin canonique, ou le chemin tel quel s'il n'existe plus. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
