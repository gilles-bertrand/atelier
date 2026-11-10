/**
 * Déplacement d'une conversation par glisser-déposer (#21), canal
 * `session:set-project` : vrais `ChatManager` et `ProjectService` sur des
 * stores en mémoire, session agent factice.
 */
import type { TurnResult } from '@atelier/agent-core';
import type { AgentEventSink, SessionSummary } from '@atelier/shared';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createHandlers, type HandlerServices } from '../handlers.js';
import {
  ChatManager,
  type AgentSessionFactory,
  type AgentSessionLike,
  type NewAgentSession,
} from '../runtime/chat-manager.js';
import { PermissionBroker } from '../runtime/permission-broker.js';
import { InMemorySessionStore } from '../runtime/session-store.js';
import { InMemoryArtifactStore } from './artifact-store.js';
import { ProjectService } from './project-service.js';
import { InMemoryProjectStore, type StoredProject } from './project-store.js';

const AT = '2026-11-10T09:00:00.000Z';

const project = (id: string, primary: string, extra: Partial<StoredProject> = {}) => ({
  id,
  name: `Projet ${id}`,
  description: '',
  instructions: `Consignes de ${id}`,
  folders: [{ path: primary, label: id, access: 'write' as const }],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** Session agent factice : garde l'historique, peut rester bloquée sur un tour. */
class FakeSession implements AgentSessionLike {
  history: readonly ModelMessage[];
  constructor(
    options: NewAgentSession,
    private readonly gate: () => Promise<void>,
  ) {
    this.history = options.history;
  }

  async send(
    input: string,
    emit: AgentEventSink,
    _signal?: AbortSignal,
    options?: { turnId?: string },
  ): Promise<TurnResult> {
    await this.gate();
    this.history = [...this.history, { role: 'user', content: input }];
    emit({ type: 'done', sessionId: 's', turnId: options?.turnId ?? 't', reason: 'stop' });
    return { messages: [...this.history], reason: 'stop' };
  }
}

function setup() {
  const sessions = new InMemorySessionStore();
  const store = new InMemoryProjectStore();
  store.save(
    project('ventes', '/u/Ventes', {
      name: 'Ventes',
      folders: [
        { path: '/u/Ventes', label: 'Ventes', access: 'write' },
        { path: '/u/Compta', label: 'Compta', access: 'read' },
      ],
    }),
  );
  store.save(project('jumeau', '/u/Ventes', { name: 'Ventes bis' }));
  store.save(project('autre', '/u/Autre', { name: 'Autre' }));
  store.save(project('archive', '/u/Ventes', { name: 'Ancien', archivedAt: AT }));
  const changed: string[] = [];
  const projects = new ProjectService({
    store,
    artifacts: new InMemoryArtifactStore(),
    sessions,
    projectsDir: () => '/u/Projets',
    home: '/u',
    onProjectChanged: (id) => changed.push(id),
  });
  // Tour bloqué tant que `release` n'est pas appelé (`hold`).
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const created: NewAgentSession[] = [];
  const agents: AgentSessionFactory = {
    generation: () => 0,
    beforeTurn: () => Promise.resolve(),
    createSession: (options) => {
      created.push(options);
      return Promise.resolve(new FakeSession(options, () => pending ?? Promise.resolve()));
    },
  };
  const chats = new ChatManager({
    store: sessions,
    permissions: new PermissionBroker(),
    agents,
    emit: () => undefined,
    projects,
    trackChanges: () => ({ start: () => Promise.resolve(), afterTool: () => Promise.resolve([]) }),
  });
  const handlers = createHandlers({ chats, projects, home: '/u' } as unknown as HandlerServices);
  // `async` : une erreur levée par le handler devient un rejet.
  const move = async (sessionId: string, projectId: string | null): Promise<SessionSummary> =>
    (await handlers['session:set-project']?.({ sessionId, projectId })) as SessionSummary;
  const turn = async (sessionId: string, text: string): Promise<void> => {
    chats.send(sessionId, text);
    while (chats.isRunning(sessionId)) await new Promise((r) => setTimeout(r, 1));
  };
  const hold = (): void => {
    pending = new Promise<void>((resolve) => {
      release = () => {
        pending = undefined;
        resolve();
      };
    });
  };
  return {
    chats,
    sessions,
    changed,
    created,
    move,
    turn,
    hold,
    release: () => release?.(),
  };
}

describe('session:set-project (#21)', () => {
  it('entre dans le projet dont le dossier est le principal ; le tour suivant prend son contexte', async () => {
    const { chats, sessions, changed, created, move, turn } = setup();
    const session = chats.create('/u/Ventes');
    await turn(session.id, 'Premier message');
    expect(created[0]?.project).toBeUndefined();

    const moved = await move(session.id, 'ventes');
    expect(moved).toMatchObject({ id: session.id, workspace: '/u/Ventes', projectId: 'ventes' });
    expect(sessions.get(session.id)?.projectId).toBe('ventes');
    expect(changed).toEqual(['ventes']);

    // Tour suivant : session agent recréée avec le projet, historique conservé.
    await turn(session.id, 'Deuxième message');
    expect(created).toHaveLength(2);
    expect(created[1]?.workspace).toBe('/u/Ventes');
    expect(created[1]?.history).toEqual([
      { role: 'user', content: expect.stringContaining('Premier message') as unknown },
    ]);
    expect(created[1]?.tools?.map((t) => t.name)).toContain('memory_add');
    const context = await created[1]?.project?.();
    expect(context).toMatchObject({ name: 'Ventes', instructions: 'Consignes de ventes' });
    expect(context?.folders.map((f) => f.label)).toEqual(['Compta']);
  });

  it('passe d’un projet à l’autre et signale les deux projets', async () => {
    const { chats, changed, move } = setup();
    const session = chats.create('/u/Ventes', { projectId: 'ventes' });
    expect(await move(session.id, 'jumeau')).toMatchObject({ projectId: 'jumeau' });
    expect(changed).toEqual(['ventes', 'jumeau']);
  });

  it('sortir d’un projet est toujours permis ; le tour suivant est hors projet', async () => {
    const { chats, changed, created, move, turn } = setup();
    const session = chats.create('/u/Ventes', { projectId: 'ventes' });
    await turn(session.id, 'Dans le projet');
    expect(created[0]?.project).toBeTypeOf('function');

    const moved = await move(session.id, null);
    expect(moved.projectId).toBeUndefined();
    expect(moved.workspace).toBe('/u/Ventes');
    expect(changed).toEqual(['ventes']);

    await turn(session.id, 'Hors projet');
    expect(created).toHaveLength(2);
    expect(created[1]?.project).toBeUndefined();
    expect(created[1]?.tools?.map((t) => t.name)).not.toContain('memory_add');
  });

  it('refuse avec le motif : autre dossier, projet archivé, run planifié ; rien ne change', async () => {
    const { chats, sessions, changed, move } = setup();
    const ailleurs = chats.create('/u/Compta');
    await expect(move(ailleurs.id, 'ventes')).rejects.toMatchObject({
      code: 'session/move_refused',
      message: expect.stringMatching(/autre dossier que celui du projet « Ventes »/) as unknown,
    });
    const ventes = chats.create('/u/Ventes');
    await expect(move(ventes.id, 'archive')).rejects.toMatchObject({
      code: 'session/move_refused',
      message: expect.stringMatching(/« Ancien » est archivé/) as unknown,
    });
    const run = chats.create('/u/Ventes', { projectId: 'ventes', scheduledTaskId: 't1' });
    await expect(move(run.id, null)).rejects.toMatchObject({
      code: 'session/move_refused',
      message: expect.stringMatching(/tâche planifiée/) as unknown,
    });
    expect(sessions.get(ailleurs.id)?.projectId).toBeUndefined();
    expect(sessions.get(ventes.id)?.projectId).toBeUndefined();
    expect(sessions.get(run.id)?.projectId).toBe('ventes');
    expect(changed).toEqual([]);
  });

  it('refuse pendant un tour (agent/busy), puis accepte une fois le tour fini', async () => {
    const { chats, sessions, changed, move, hold, release } = setup();
    const session = chats.create('/u/Ventes');
    hold();
    chats.send(session.id, 'Long travail');
    expect(chats.isRunning(session.id)).toBe(true);
    await expect(move(session.id, 'ventes')).rejects.toMatchObject({ code: 'agent/busy' });
    expect(sessions.get(session.id)?.projectId).toBeUndefined();
    expect(changed).toEqual([]);
    release();
    while (chats.isRunning(session.id)) await new Promise((r) => setTimeout(r, 1));
    expect(await move(session.id, 'ventes')).toMatchObject({ projectId: 'ventes' });
  });

  it('déjà à sa place : rien à signaler ; introuvables : session/not_found, project/not_found', async () => {
    const { chats, changed, move } = setup();
    const session = chats.create('/u/Ventes', { projectId: 'ventes' });
    expect(await move(session.id, 'ventes')).toMatchObject({ projectId: 'ventes' });
    const single = chats.create('/u/Autre');
    expect((await move(single.id, null)).projectId).toBeUndefined();
    expect(changed).toEqual([]);
    await expect(move('inconnue', null)).rejects.toMatchObject({ code: 'session/not_found' });
    await expect(move(session.id, 'inconnu')).rejects.toMatchObject({
      code: 'project/not_found',
    });
  });
});
