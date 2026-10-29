/** Messages injectés par l'app (relances, résumé) : marqueur providerOptions.atelier.kind. */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  AgentSession,
  compactMessages,
  continuationPrompt,
  createDefaultRegistry,
  createLlmModels,
  currentTurnStart,
  injectedKind,
  injectedMessage,
  SUMMARY_PREFIX,
} from '../src/index.js';
import {
  collect,
  permissions,
  promptText,
  scriptedModel,
  summaryModel,
  withTempDir,
} from './helpers.js';

type FetchArgs = Parameters<typeof fetch>;

const TODO = [{ id: 'a', title: 'Écrire le rapport', status: 'pending' as const }];

describe('injectedKind', () => {
  it('reconnaît le marqueur, quel que soit le texte', () => {
    expect(injectedKind(injectedMessage('continuation', 'texte libre'))).toBe('continuation');
    expect(injectedKind(injectedMessage('summary', 'résumé'))).toBe('summary');
  });

  it('un message tapé par l’utilisateur qui commence par « [Atelier] » reste une demande', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'première demande' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: '[Atelier] fais-moi le bilan du mois' },
    ];
    expect(injectedKind(messages[2] as ModelMessage)).toBeUndefined();
    expect(currentTurnStart(messages)).toBe(2);
  });

  it('ignore les faux marqueurs et les rôles autres que user', () => {
    expect(
      injectedKind({ role: 'user', content: 'x', providerOptions: { atelier: { kind: 'autre' } } }),
    ).toBeUndefined();
    expect(injectedKind({ role: 'assistant', content: [] })).toBeUndefined();
  });
});

describe('compatibilité avec les historiques persistés sans marqueur', () => {
  /** Historique tel qu'il était enregistré en SQLite avant le marqueur (JSON, sans providerOptions). */
  function legacyHistory(): ModelMessage[] {
    return JSON.parse(
      JSON.stringify([
        { role: 'user', content: `${SUMMARY_PREFIX}\nL'utilisateur prépare un rapport.` },
        { role: 'user', content: 'Écris le rapport de mars.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Je commence.' }] },
        { role: 'user', content: continuationPrompt(TODO) },
        { role: 'assistant', content: [{ type: 'text', text: 'Rapport écrit.' }] },
      ]),
    ) as ModelMessage[];
  }

  it('les anciens résumés et relances sont reconnus par leur texte exact', () => {
    const history = legacyHistory();
    expect(injectedKind(history[0] as ModelMessage)).toBe('summary');
    expect(injectedKind(history[3] as ModelMessage)).toBe('continuation');
    expect(currentTurnStart(history)).toBe(1);
  });

  it('une session rechargée depuis un ancien historique enchaîne un tour normalement', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Voici le bilan.' }]);
      const fast = summaryModel('Résumé.');
      const agent = new Agent({
        model,
        fastModel: fast,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32_768,
      });
      const session = new AgentSession(agent, 's', legacyHistory(), 30_000);
      const { emit } = collect();
      const result = await session.send('Et le bilan ?', emit);
      expect(result.reason).toBe('stop');
      // Compaction préalable (30 000 > 75 %) : la nouvelle demande est gardée telle quelle.
      const sent = promptText(model, 0);
      expect(sent).toContain('Et le bilan ?');
      expect(result.messages.some((m) => m.role === 'user' && m.content === 'Et le bilan ?')).toBe(
        true,
      );
    });
  });
});

describe('marqueur dans la boucle', () => {
  it('le résumé de compaction est marqué et survit à la persistance JSON', async () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(
        { role: 'user', content: `question ${String(i)}` },
        { role: 'assistant', content: [{ type: 'text', text: `réponse ${String(i)}` }] },
      );
    }
    messages.push({ role: 'user', content: 'nouvelle demande' });
    const result = await compactMessages({
      model: summaryModel('Résumé.'),
      messages,
      keepRecent: 2,
    });
    const persisted = JSON.parse(JSON.stringify(result.messages)) as ModelMessage[];
    expect(injectedKind(persisted[0] as ModelMessage)).toBe('summary');
    expect(currentTurnStart(persisted)).toBe(persisted.length - 1);
  });

  it('la relance est marquée, et le marqueur n’est pas envoyé au serveur', async () => {
    await withTempDir(async (ws) => {
      const bodies: Record<string, unknown>[] = [];
      const sse = (chunks: unknown[]): Response =>
        new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const todo = {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: {
          name: 'todo_write',
          arguments: JSON.stringify({ todos: TODO }),
        },
      };
      const replies = [
        sse([chunk({ tool_calls: [todo] }), chunk({}, 'tool_calls')]),
        sse([chunk({ content: 'Je l’écris.' }), chunk({}, 'stop')]),
        sse([chunk({ content: 'Fait.' }), chunk({}, 'stop')]),
      ];
      const fakeFetch = vi.fn((_url: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
        );
        return Promise.resolve(replies.shift() ?? sse([chunk({}, 'stop')]));
      });
      const { model } = createLlmModels({
        baseUrl: 'https://llm.example.com',
        model: 'm',
        fetch: fakeFetch,
      });
      const agent = new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32_768,
      });
      const { emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Écris le rapport',
        emit,
      });
      const relaunch = result.messages.find((m) => injectedKind(m) === 'continuation');
      expect(relaunch?.providerOptions).toEqual({ atelier: { kind: 'continuation' } });
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      const sent = JSON.stringify(bodies[2]);
      expect(sent).toContain('Ta réponse s');
      expect(sent).not.toContain('"atelier"');
      expect(sent).not.toContain('"kind"');
      expect(sent).not.toContain('providerOptions');
    });
  });
});
