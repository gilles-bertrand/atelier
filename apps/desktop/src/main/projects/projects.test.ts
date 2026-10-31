/**
 * Projets côté main (ADR-003) : stores (mémoire et SQLite), migration n° 5,
 * service, protocole des artefacts, bail sur les montages et intégration au
 * `ChatManager`.
 */
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ARTIFACT_VERSIONS,
  MAX_MEMORY_REVISIONS,
  type AgentEvent,
  type ScheduledTask,
  type SessionSummary,
} from '@atelier/shared';
import { PermissionBroker } from '../runtime/permission-broker.js';
import {
  ChatManager,
  type AgentSessionFactory,
  type AgentSessionLike,
  type NewAgentSession,
} from '../runtime/chat-manager.js';
import { InMemorySessionStore, type SessionStore } from '../runtime/session-store.js';
import { migrate, MIGRATIONS, openDatabase, SqliteSessionStore } from '../runtime/sqlite-store.js';
import { WorkspaceLease } from '../schedule/workspace-lease.js';
import {
  ARTIFACT_CSP,
  handleArtifactRequest,
  isAllowedSubframeUrl,
  parseVersionPath,
} from './artifact-protocol.js';
import {
  InMemoryArtifactStore,
  SqliteArtifactStore,
  type ArtifactPublication,
  type ArtifactStore,
} from './artifact-store.js';
import { mountSignature, sandboxMounts } from './project-mounts.js';
import { ProjectService, type ProjectTasks } from './project-service.js';
import {
  InMemoryProjectStore,
  SqliteProjectStore,
  type ProjectStore,
  type StoredProject,
} from './project-store.js';

const AT = '2026-10-31T09:00:00.000Z';

const project = (id: string, extra: Partial<StoredProject> = {}): StoredProject => ({
  id,
  name: `Projet ${id}`,
  description: '',
  instructions: '',
  folders: [{ path: `/u/${id}`, label: id, access: 'write' }],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const conversation = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  workspace: '/u/w',
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** Stores branchés sur une même base (SQLite) ou indépendants (mémoire). */
interface Stores {
  projects: ProjectStore;
  artifacts: ArtifactStore;
  sessions: SessionStore;
}

const storeKinds: [string, () => Promise<Stores>][] = [
  [
    'mémoire',
    () =>
      Promise.resolve({
        projects: new InMemoryProjectStore(),
        artifacts: new InMemoryArtifactStore(),
        sessions: new InMemorySessionStore(),
      }),
  ],
  [
    'SQLite',
    async () => {
      const db = await openDatabase(':memory:');
      return {
        projects: new SqliteProjectStore(db),
        artifacts: new SqliteArtifactStore(db),
        sessions: new SqliteSessionStore(db),
      };
    },
  ],
];

describe.each(storeKinds)('ProjectStore (%s)', (_name, make) => {
  it('enregistre un projet et ses dossiers, liste sans les archivés', async () => {
    const { projects } = await make();
    projects.save(
      project('a', {
        folders: [
          { path: '/u/a', label: 'a', access: 'write' },
          { path: '/u/compta', label: 'Compta', access: 'read' },
        ],
      }),
    );
    projects.save(project('b', { archivedAt: AT }));
    expect(projects.get('a')?.folders).toEqual([
      { path: '/u/a', label: 'a', access: 'write' },
      { path: '/u/compta', label: 'Compta', access: 'read' },
    ]);
    expect(projects.list().map((p) => p.id)).toEqual(['a']);
    expect(
      projects
        .list({ includeArchived: true })
        .map((p) => p.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(projects.get('absent')).toBeUndefined();
  });

  it('versionne la mémoire, détecte un conflit et garde la première révision', async () => {
    const { projects, sessions } = await make();
    projects.save(project('a'));
    sessions.create(conversation('s1', { projectId: 'a' }));
    expect(projects.memory('a')).toEqual({ content: '', revision: 0 });
    projects.writeMemory('a', { content: 'v1', source: 'user', baseRevision: 0, at: AT });
    const second = projects.writeMemory('a', {
      content: 'v2',
      source: 'agent',
      sessionId: 's1',
      at: AT,
    });
    expect(second).toMatchObject({ content: 'v2', revision: 2 });
    expect(() =>
      projects.writeMemory('a', { content: 'v3', source: 'user', baseRevision: 1, at: AT }),
    ).toThrow(expect.objectContaining({ code: 'project/conflict' }));
    const history = projects.memoryHistory('a');
    expect(history.map((r) => [r.revision, r.source, r.sessionId])).toEqual([
      [2, 'agent', 's1'],
      [1, 'user', undefined],
    ]);
    for (let i = 3; i <= MAX_MEMORY_REVISIONS + 20; i += 1) {
      projects.writeMemory('a', { content: `v${String(i)}`, source: 'agent', at: AT });
    }
    const all = projects.memoryHistory('a', 1000);
    expect(all).toHaveLength(MAX_MEMORY_REVISIONS);
    expect(all.at(-1)?.revision).toBe(1);
    expect(all[0]?.revision).toBe(MAX_MEMORY_REVISIONS + 20);
    expect(() => projects.memory('absent')).toThrow(
      expect.objectContaining({ code: 'project/not_found' }),
    );
  });
});

describe.each(storeKinds)('ArtifactStore (%s)', (_name, make) => {
  const publication = (extra: Partial<ArtifactPublication> = {}): ArtifactPublication => ({
    projectId: 'p',
    path: '/u/p/Artefacts/ventes.html',
    title: 'Ventes',
    format: 'html',
    content: new TextEncoder().encode('<h1>v1</h1>'),
    at: AT,
    ...extra,
  });

  it('republier le même fichier ajoute une version au même artefact', async () => {
    const { artifacts, projects, sessions } = await make();
    projects.save(project('p'));
    projects.save(project('q'));
    sessions.create(conversation('run-session', { projectId: 'p' }));
    const first = artifacts.publish(publication());
    const second = artifacts.publish(
      publication({
        title: 'Tableau des ventes',
        content: new TextEncoder().encode('<h1>v2</h1>'),
        sessionId: 'run-session',
        runId: 'r1',
        taskName: 'Rapport hebdo',
        at: '2026-10-31T10:00:00.000Z',
      }),
    );
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      title: 'Tableau des ventes',
      runId: 'r1',
      taskName: 'Rapport hebdo',
    });
    // Même chemin dans un autre projet : un autre artefact.
    const other = artifacts.publish(publication({ projectId: 'q' }));
    expect(other.id).not.toBe(first.id);
    expect(artifacts.list('p').map((a) => a.id)).toEqual([first.id]);
    expect(artifacts.versions(first.id).map((v) => v.version)).toEqual([2, 1]);
    const latest = artifacts.content(first.id);
    expect(new TextDecoder().decode(latest?.content)).toBe('<h1>v2</h1>');
    expect(new TextDecoder().decode(artifacts.content(first.id, 1)?.content)).toBe('<h1>v1</h1>');
    expect(artifacts.content(first.id, 9)).toBeUndefined();
  });

  it(`garde les ${String(MAX_ARTIFACT_VERSIONS)} dernières versions et se supprime`, async () => {
    const { artifacts, projects } = await make();
    projects.save(project('p'));
    let id = '';
    for (let i = 0; i < MAX_ARTIFACT_VERSIONS + 5; i += 1) id = artifacts.publish(publication()).id;
    const versions = artifacts.versions(id);
    expect(versions).toHaveLength(MAX_ARTIFACT_VERSIONS);
    expect(versions.at(-1)?.version).toBe(6);
    artifacts.delete(id);
    expect(artifacts.get(id)).toBeUndefined();
    expect(() => artifacts.versions(id)).toThrow(
      expect.objectContaining({ code: 'artifact/not_found' }),
    );
  });
});

describe('SQLite : migration n° 5 et cascades', () => {
  it('migre une base v4 : colonnes project_id vides, tables des projets créées', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    for (const [index, sql] of MIGRATIONS.slice(0, 4).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
    }
    db.exec(`INSERT INTO sessions (id, title, workspace, created_at, updated_at)
             VALUES ('s', 'Ancienne', '/u/w', '${AT}', '${AT}')`);
    migrate(db);
    const sessions = new SqliteSessionStore(db);
    expect(sessions.get('s')).not.toHaveProperty('projectId');
    expect(new SqliteProjectStore(db).list()).toEqual([]);
  });

  it('compte conversations, tâches et artefacts ; la suppression suit en cascade', async () => {
    const db = await openDatabase(':memory:');
    const projects = new SqliteProjectStore(db);
    const sessions = new SqliteSessionStore(db);
    const artifacts = new SqliteArtifactStore(db);
    projects.save(project('p'));
    sessions.create(conversation('c1', { projectId: 'p' }));
    sessions.create(
      conversation('run', {
        projectId: 'p',
        scheduledTaskId: 't',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }),
    );
    artifacts.publish({
      projectId: 'p',
      path: '/u/p/a.html',
      title: 'A',
      format: 'html',
      content: new Uint8Array([60]),
      at: AT,
    });
    const [summary] = projects.list();
    expect(summary).toMatchObject({ conversations: 1, tasks: 0, artifacts: 1 });
    expect(summary?.lastActivityAt).toBe('2026-11-01T00:00:00.000Z');
    expect(sessions.list(10, { projectId: 'p' }).map((s) => s.id)).toEqual(['c1']);
    projects.delete('p');
    expect(sessions.get('c1')).toBeUndefined();
    expect(artifacts.list()).toEqual([]);
  });
});

describe('protocole atelier-artifact:', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atelier-art-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sert une version HTML avec une CSP sans réseau et en bac à sable', async () => {
    const artifacts = new InMemoryArtifactStore(() => 'a1');
    const html = '<script>document.title = "ok"</script>';
    artifacts.publish({
      path: '/u/a.html',
      title: 'A',
      format: 'html',
      content: new TextEncoder().encode(html),
      at: AT,
    });
    const response = await handleArtifactRequest('atelier-artifact://a1/v1/', artifacts, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toBe(ARTIFACT_CSP);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(await response.text()).toBe(html);
    const latest = await handleArtifactRequest('atelier-artifact://a1/latest/', artifacts, {});
    expect(latest.headers.get('X-Atelier-Artifact-Version')).toBe('1');
  });

  it('sert le Markdown en texte, refuse les ressources relatives et les inconnus', async () => {
    const artifacts = new InMemoryArtifactStore(() => 'm1');
    artifacts.publish({
      path: '/u/r.md',
      title: 'R',
      format: 'markdown',
      content: new TextEncoder().encode('# Bilan'),
      at: AT,
    });
    const md = await handleArtifactRequest('atelier-artifact://m1/v1/', artifacts, {});
    expect(md.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    for (const url of [
      'atelier-artifact://m1/v1/data.json',
      'atelier-artifact://m1/v2/',
      'atelier-artifact://absent/v1/',
    ]) {
      expect((await handleArtifactRequest(url, artifacts, {})).status).toBe(404);
    }
    expect((await handleArtifactRequest('pas une url', artifacts, {})).status).toBe(400);
  });

  it('sert les bibliothèques de la liste blanche seulement', async () => {
    const lib = join(dir, 'chart.umd.min.js');
    await writeFile(lib, 'window.Chart = {};');
    const libraries = { 'chart.umd.min.js': lib };
    const store = new InMemoryArtifactStore();
    const ok = await handleArtifactRequest(
      'atelier-artifact://lib/chart.umd.min.js',
      store,
      libraries,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await ok.text()).toBe('window.Chart = {};');
    for (const url of ['atelier-artifact://lib/autre.js', 'atelier-artifact://lib/toString']) {
      expect((await handleArtifactRequest(url, store, libraries)).status).toBe(404);
    }
  });

  it('chemins de version et navigations de sous-cadre permises', () => {
    expect(parseVersionPath('/v12/')).toBe(12);
    expect(parseVersionPath('/v3/index.html')).toBe(3);
    expect(parseVersionPath('/latest/')).toBeUndefined();
    for (const bad of ['/v0/', '/v1', '/v1/../x', '/x/']) expect(parseVersionPath(bad)).toBeNull();
    expect(isAllowedSubframeUrl('atelier-artifact://a1/v1/')).toBe(true);
    expect(isAllowedSubframeUrl('about:srcdoc')).toBe(true);
    expect(isAllowedSubframeUrl('https://evil.example.com/?d=1')).toBe(false);
    expect(isAllowedSubframeUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedSubframeUrl('atelier-file://preview/?path=x', ['atelier-file:'])).toBe(true);
  });
});

describe('ProjectService', () => {
  let root: string;
  let home: string;
  let projectsDir: string;
  let forbidden: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-proj-')));
    home = join(root, 'home');
    projectsDir = join(home, 'Atelier', 'Projets');
    forbidden = join(home, 'Atelier', 'skills');
    await mkdir(forbidden, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function service(
    extra: { tasks?: ProjectTasks; runOf?: () => { runId: string; taskName: string } } = {},
  ) {
    const store = new InMemoryProjectStore();
    const artifacts = new InMemoryArtifactStore();
    const sessions = new InMemorySessionStore();
    const changed: string[] = [];
    const published: string[] = [];
    const deleted: string[] = [];
    const projects = new ProjectService({
      store,
      artifacts,
      sessions,
      projectsDir: () => projectsDir,
      home,
      forbiddenRoots: () => [forbidden],
      deleteSession: (id) => {
        deleted.push(id);
        sessions.delete(id);
        return Promise.resolve();
      },
      ...(extra.tasks ? { tasks: () => extra.tasks } : {}),
      ...(extra.runOf ? { runOf: extra.runOf } : {}),
      onProjectChanged: (id) => changed.push(id),
      onArtifactChanged: (a) => published.push(`${a.title} v${String(a.version)}`),
      now: () => new Date(AT),
    });
    return { projects, store, artifacts, sessions, changed, published, deleted };
  }

  async function folder(name: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it('crée le dossier du projet sous ~/Atelier/Projets, sans écraser un dossier existant', async () => {
    const { projects, changed } = service();
    const first = await projects.create({ name: '  Ventes 2026 ', description: ' Suivi ' });
    expect(first).toMatchObject({ name: 'Ventes 2026', description: 'Suivi' });
    expect(first.folders).toEqual([
      { path: join(projectsDir, 'Ventes 2026'), label: 'Ventes 2026', access: 'write' },
    ]);
    expect((await stat(join(projectsDir, 'Ventes 2026'))).isDirectory()).toBe(true);
    const second = await projects.create({ name: 'Ventes 2026' });
    expect(second.folders[0]?.path).toBe(join(projectsDir, 'Ventes 2026 2'));
    expect(changed).toEqual([first.id, second.id]);
    await expect(projects.create({ name: '  ' })).rejects.toMatchObject({
      code: 'project/invalid',
      details: { field: 'name' },
    });
  });

  it('dossiers existants : chemins canoniques, libellés par défaut, refus clairs', async () => {
    const { projects } = await Promise.resolve(service());
    const main = await folder('Clients');
    const compta = await folder('Compta');
    const link = join(root, 'lien-compta');
    await symlink(compta, link);
    const created = await projects.create({
      name: 'Clients',
      folders: [
        { path: main, label: '', access: 'write' },
        { path: link, label: '', access: 'read' },
      ],
    });
    expect(created.folders).toEqual([
      { path: main, label: 'Clients', access: 'write' },
      { path: compta, label: 'Compta', access: 'read' },
    ]);
    const refused = async (path: string, index = 1): Promise<void> => {
      await expect(
        projects.create({
          name: 'X',
          folders: [
            { path: main, label: 'Clients', access: 'write' },
            { path, label: 'Autre', access: 'write' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'project/invalid', details: { field: 'folders', index } });
    };
    await refused(join(root, 'absent'));
    await refused(home);
    await refused(forbidden);
    await mkdir(join(main, 'sous'));
    await refused(join(main, 'sous'));
    // Imbrication masquée par « .. » ou par un lien symbolique : vue sur le chemin
    // canonique (realpath avant validateProjectInput, relecture du Lead sur PR #121).
    await refused(join(root, 'Compta', '..', 'Clients', 'sous'));
    const nestedLink = join(root, 'lien-sous');
    await symlink(join(main, 'sous'), nestedLink);
    await refused(nestedLink);
  });

  it('changer le dossier principal déplace les conversations et les tâches du projet', async () => {
    const retargeted: string[] = [];
    const tasks: ProjectTasks = {
      list: () => [{ id: 't1', projectId: 'p' } as ScheduledTask, { id: 't2' } as ScheduledTask],
      setEnabled: vi.fn(),
      delete: vi.fn(() => Promise.resolve()),
      retarget: (id, workspace) => retargeted.push(`${id}@${workspace}`),
    };
    const { projects, sessions } = service({ tasks });
    const a = await folder('A');
    const b = await folder('B');
    const created = await projects.create({
      name: 'P',
      folders: [{ path: a, label: 'A', access: 'write' }],
    });
    sessions.create(conversation('c', { projectId: created.id, workspace: a }));
    tasks.list = () => [{ id: 't1', projectId: created.id } as ScheduledTask];
    await projects.update(created.id, {
      folders: [
        { path: b, label: 'B', access: 'write' },
        { path: a, label: 'A', access: 'read' },
      ],
    });
    expect(sessions.get('c')?.workspace).toBe(b);
    expect(retargeted).toEqual([`t1@${b}`]);
  });

  it('archiver désactive les tâches actives du projet ; supprimer ne touche pas au disque', async () => {
    const setEnabled = vi.fn();
    const removed: string[] = [];
    const tasks: ProjectTasks = {
      list: () => [],
      setEnabled,
      delete: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
      retarget: vi.fn(),
    };
    const { projects, sessions, artifacts, deleted } = service({ tasks });
    const created = await projects.create({ name: 'P' });
    tasks.list = () => [
      { id: 't1', projectId: created.id, enabled: true } as ScheduledTask,
      { id: 't2', projectId: created.id, enabled: false } as ScheduledTask,
      { id: 't3', projectId: 'autre', enabled: true } as ScheduledTask,
    ];
    expect(projects.setArchived(created.id, true).archivedAt).toBe(AT);
    expect(setEnabled.mock.calls).toEqual([['t1', false]]);
    expect(projects.list().map((p) => p.id)).toEqual([]);
    expect(projects.setArchived(created.id, false).archivedAt).toBeUndefined();

    sessions.create(conversation('c1', { projectId: created.id }));
    sessions.create(conversation('hors', {}));
    artifacts.publish({
      projectId: created.id,
      path: '/x.html',
      title: 'X',
      format: 'html',
      content: new Uint8Array(),
      at: AT,
    });
    await projects.delete(created.id);
    expect(deleted).toEqual(['c1']);
    expect(removed).toEqual(['t1', 't2']);
    expect(artifacts.list()).toEqual([]);
    expect(sessions.get('hors')).toBeDefined();
    expect((await stat(created.folders[0]?.path ?? '')).isDirectory()).toBe(true);
    expect(() => projects.get(created.id)).toThrow(
      expect.objectContaining({ code: 'project/not_found' }),
    );
  });

  it('« Créer un projet à partir de ce dossier » y range les conversations hors projet', async () => {
    const { projects, sessions } = service();
    const dir = await folder('Dossier client');
    sessions.create(conversation('c1', { workspace: dir }));
    sessions.create(conversation('run', { workspace: dir, scheduledTaskId: 't' }));
    sessions.create(conversation('ailleurs', { workspace: '/u/autre' }));
    const created = await projects.fromFolder(dir);
    expect(created.name).toBe('Dossier client');
    expect(sessions.get('c1')?.projectId).toBe(created.id);
    expect(sessions.get('run')?.projectId).toBeUndefined();
    expect(sessions.get('ailleurs')?.projectId).toBeUndefined();
  });

  it('mémoire : notes de l’agent datées, édition avec conflit, limite de taille', async () => {
    const { projects, sessions, store } = service({
      runOf: () => ({ runId: 'r1', taskName: 'Rapport' }),
    });
    const created = await projects.create({ name: 'P' });
    sessions.create(conversation('c', { projectId: created.id }));
    sessions.create(conversation('hors'));
    await projects.append('c', 'Le client préfère les PDF.');
    expect(projects.memory(created.id).content).toBe(
      '## Notes\n\n- 31/10/2026 : Le client préfère les PDF.\n',
    );
    expect(store.memoryHistory(created.id)[0]).toMatchObject({
      source: 'agent',
      sessionId: 'c',
      runId: 'r1',
    });
    await expect(projects.append('hors', 'x')).rejects.toMatchObject({
      code: 'project/not_found',
    });
    expect(() => projects.saveMemory(created.id, 'édité', 0)).toThrow(
      expect.objectContaining({ code: 'project/conflict' }),
    );
    expect(projects.saveMemory(created.id, 'édité', 1)).toMatchObject({ revision: 2 });
    expect(() => projects.saveMemory(created.id, 'x'.repeat(50_001), 2)).toThrow(
      expect.objectContaining({ code: 'project/invalid' }),
    );
  });

  it('publication : projet de la conversation, provenance du run, carte et événement', async () => {
    const { projects, sessions, published } = service({
      runOf: () => ({ runId: 'r1', taskName: 'Rapport hebdo' }),
    });
    const created = await projects.create({ name: 'P' });
    sessions.create(conversation('c', { projectId: created.id }));
    const request = {
      sessionId: 'c',
      path: '/u/P/Artefacts/a.html',
      displayPath: 'Artefacts/a.html',
      title: 'Ventes',
      format: 'html' as const,
      content: new Uint8Array([1]),
    };
    await projects.publish(request);
    const card = await projects.publish(request);
    expect(card).toMatchObject({ title: 'Ventes', version: 2, path: request.path });
    expect(projects.listArtifacts(created.id)[0]).toMatchObject({
      projectId: created.id,
      runId: 'r1',
      taskName: 'Rapport hebdo',
    });
    expect(published).toEqual(['Ventes v1', 'Ventes v2']);
  });

  it('contexte de tour : dossiers rattachés, montages, prompt et outils', async () => {
    const { projects, sessions } = service();
    const main = await folder('Main');
    const compta = await folder('Compta');
    const created = await projects.create({
      name: 'Ventes',
      instructions: 'Réponds en tableau.',
      folders: [
        { path: main, label: 'Main', access: 'write' },
        { path: compta, label: 'Compta', access: 'read' },
      ],
    });
    sessions.create(conversation('c', { projectId: created.id, workspace: main }));
    sessions.create(conversation('hors', { workspace: main }));
    const turn = projects.turnFor(conversation('c', { projectId: created.id, workspace: main }));
    expect(turn?.folders).toEqual([
      { path: compta, label: 'Compta', access: 'read', guestPath: '/dossiers/Compta' },
    ]);
    expect(sandboxMounts(turn?.folders ?? [])).toEqual([
      { host: compta, guest: '/dossiers/Compta', writable: false },
    ]);
    const task = { projectId: created.id } as ScheduledTask;
    expect(projects.leaseFor(task)).toEqual({ projectName: 'Ventes', mounts: turn?.mounts });
    expect(turn?.mounts).toBe(mountSignature(main, turn?.folders ?? []));
    expect(projects.turnFor(conversation('hors', { workspace: main }))).toBeUndefined();

    await projects.append('c', 'Une note.');
    await projects.publish({
      sessionId: 'c',
      path: join(compta, 'bilan.md'),
      displayPath: 'Compta/bilan.md',
      title: 'Bilan',
      format: 'markdown',
      content: new Uint8Array(),
    });
    const prompt = await projects.promptProject('c')();
    expect(prompt).toMatchObject({
      name: 'Ventes',
      instructions: 'Réponds en tableau.',
      artifacts: [{ title: 'Bilan', path: 'Compta/bilan.md', version: 1 }],
    });
    expect(prompt?.memory).toContain('Une note.');
    expect(await projects.promptProject('hors')()).toBeUndefined();
    const names = (s: SessionSummary): string[] => projects.sessionTools(s).map((t) => t.name);
    expect(names(conversation('c', { projectId: created.id }))).toEqual([
      'memory_add',
      'memory_rewrite',
      'publish_artifact',
    ]);
    expect(names(conversation('hors'))).toEqual(['publish_artifact']);
    // Run planifié sans la case mémoire : aucun outil de mémoire proposé.
    expect(
      projects
        .sessionTools(conversation('c', { projectId: created.id }), { memory: false })
        .map((t) => t.name),
    ).toEqual(['publish_artifact']);
  });
});

describe('bail de la VM et montages d’un projet', () => {
  it('même dossier mais montages différents : attente ; mêmes montages : partage', async () => {
    const lease = new WorkspaceLease();
    const release = lease.tryAcquire({ workspace: '/w', sessionId: 'a', mounts: 'M1' });
    expect(release).toBeDefined();
    expect(lease.tryAcquire({ workspace: '/w', sessionId: 'b', mounts: 'M1' })).toBeDefined();
    expect(lease.tryAcquire({ workspace: '/w', sessionId: 'c' })).toBeUndefined();
    expect(lease.holder()).toEqual({ workspace: '/w', sessionId: 'a' });
    const projectHolder = lease.tryAcquire({
      workspace: '/w',
      sessionId: 'd',
      mounts: 'M1',
      projectName: 'Ventes',
    });
    expect(projectHolder).toBeDefined();
    let granted = false;
    const waiting = lease.acquire({ workspace: '/w', sessionId: 'e', mounts: 'M2' }).then((r) => {
      granted = true;
      return r;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(lease.holder()).not.toHaveProperty('mounts');
    release?.();
    projectHolder?.();
    // « b » tient encore la VM avec M1.
    await Promise.resolve();
    expect(granted).toBe(false);
    void waiting;
  });
});

/** Session agent factice : un tour qui se termine tout de suite. */
class QuietSession implements AgentSessionLike {
  history: AgentSessionLike['history'] = [];
  lastInputTokens = undefined;
  send(
    _input: string,
    emit: (event: AgentEvent) => void,
    _signal?: AbortSignal,
    options?: { turnId?: string },
  ): ReturnType<AgentSessionLike['send']> {
    emit({ type: 'done', sessionId: 's', turnId: options?.turnId ?? 't', reason: 'stop' });
    return Promise.resolve({ messages: [], reason: 'stop' });
  }
}

describe('ChatManager et projets', () => {
  it('monte les dossiers rattachés, prend le bail des montages et passe outils et contexte', async () => {
    const store = new InMemorySessionStore();
    const prepared: { workspace: string; folders: unknown }[] = [];
    const created: NewAgentSession[] = [];
    const agents: AgentSessionFactory = {
      generation: () => 0,
      beforeTurn: (_id, workspace, options) => {
        prepared.push({ workspace, folders: options?.folders });
        return Promise.resolve();
      },
      createSession: (options) => {
        created.push(options);
        return Promise.resolve(new QuietSession());
      },
    };
    const holders: unknown[] = [];
    const lease = new WorkspaceLease({ onChange: (holder) => holders.push(holder) });
    const acquire = vi.spyOn(lease, 'acquire');
    const folders = [
      {
        path: '/u/compta',
        label: 'Compta',
        access: 'write' as const,
        guestPath: '/dossiers/Compta',
      },
    ];
    const tool = { name: 'memory_add' } as ReturnType<ProjectService['sessionTools']>[number];
    const toolOptions: unknown[] = [];
    const chats = new ChatManager({
      store,
      permissions: new PermissionBroker(),
      agents,
      emit: () => undefined,
      lease,
      trackChanges: () => ({
        start: () => Promise.resolve(),
        afterTool: () => Promise.resolve([]),
      }),
      projects: {
        turnFor: (session) =>
          session.projectId !== undefined ? { name: 'Ventes', folders, mounts: 'SIG' } : undefined,
        promptProject: () => () => Promise.resolve(undefined),
        sessionTools: (session, options) => {
          toolOptions.push(options);
          return session.projectId !== undefined ? [tool] : [];
        },
      },
    });
    const wait = async (id: string): Promise<void> => {
      while (chats.isRunning(id)) await new Promise((r) => setTimeout(r, 1));
    };
    const session = chats.create('/u/main', { projectId: 'p1' });
    expect(session.projectId).toBe('p1');
    expect(chats.list(10, { projectId: 'p1' }).map((s) => s.id)).toEqual([session.id]);
    chats.send(session.id, 'Bonjour');
    await wait(session.id);
    expect(prepared[0]).toEqual({
      workspace: '/u/main',
      folders: [{ host: '/u/compta', guest: '/dossiers/Compta', writable: true }],
    });
    expect(acquire.mock.calls[0]?.[0]).toMatchObject({
      workspace: '/u/main',
      mounts: 'SIG',
      projectName: 'Ventes',
    });
    expect(created[0]?.tools).toEqual([tool]);
    expect(created[0]?.project).toBeTypeOf('function');

    // Conversation hors projet : ni dossiers rattachés, ni contexte de projet.
    const single = chats.create('/u/autre');
    chats.send(single.id, 'Salut');
    await wait(single.id);
    expect(prepared[1]).toEqual({ workspace: '/u/autre', folders: undefined });
    expect(created[1]?.project).toBeUndefined();

    // Conversation rattachée à un projet entre deux tours : nouvelle session agent.
    store.update(single.id, { projectId: 'p1' });
    chats.send(single.id, 'Encore');
    await wait(single.id);
    expect(created).toHaveLength(3);
    expect(created[2]?.tools).toEqual([tool]);

    // Run planifié sans la case mémoire : le gestionnaire le dit au projet.
    const run = chats.create('/u/main', { projectId: 'p1', scheduledTaskId: 't1' });
    await chats.runUnattended(run.id, 'Fais le point', {
      requestPermission: () => Promise.resolve('deny'),
      useSandbox: false,
      memory: false,
    });
    expect(toolOptions.at(-1)).toEqual({ memory: false });
    expect(toolOptions[0]).toEqual({ memory: true });
  });
});

describe('handlers IPC des projets', () => {
  it('session:create et schedule:save d’un projet utilisent son dossier principal', async () => {
    const { createHandlers } = await import('../handlers.js');
    type Services = Parameters<typeof createHandlers>[0];
    const created: { workspace: string; options: unknown }[] = [];
    const saved: { workspace: string; projectId?: string }[] = [];
    const project = {
      id: 'p1',
      name: 'Ventes',
      description: '',
      instructions: '',
      folders: [{ path: '/u/Ventes', label: 'Ventes', access: 'write' }],
      createdAt: AT,
      updatedAt: AT,
    };
    const handlers = createHandlers({
      chats: {
        create: (workspace: string, options: unknown) => {
          created.push({ workspace, options });
          return conversation('c', { workspace });
        },
        list: () => [],
      },
      projects: {
        get: (id: string) => (id === 'p1' ? project : { ...project, archivedAt: AT }),
        primaryOf: () => '/u/Ventes',
        openableRoots: () => ['/u/Ventes'],
      },
      scheduler: {
        saveTask: (task: { workspace: string; projectId?: string }) => {
          saved.push(task);
          return task;
        },
      },
      home: '/u',
    } as unknown as Services);
    await handlers['session:create']?.({ workspace: '/ailleurs', projectId: 'p1' });
    expect(created).toEqual([{ workspace: '/u/Ventes', options: { projectId: 'p1' } }]);
    await expect(
      Promise.resolve(
        handlers['session:create']?.({ workspace: '/u/Ventes', projectId: 'archive' }),
      ),
    ).rejects.toMatchObject({ code: 'project/invalid' });
    await handlers['schedule:save']?.({
      task: {
        name: 'Rapport',
        prompt: 'Fais le point',
        workspace: '/ailleurs',
        projectId: 'p1',
        schedule: { kind: 'daily', time: '08:00' },
        permissions: { fileWrite: true, commands: false, webDomains: [], mcpTools: [] },
      },
    });
    expect(saved[0]).toMatchObject({ workspace: '/u/Ventes', projectId: 'p1' });
  });
});
