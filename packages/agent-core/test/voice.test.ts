/**
 * Mode vocal (ADR-004, D7, lot L8) : consignes ajoutées au tour vocal seulement,
 * thinking coupé, rythme des phrases d'attente des outils (horloge injectée).
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type AnyToolDefinition, type PermissionDecision } from '@atelier/shared';
import {
  Agent,
  AgentSession,
  createDefaultRegistry,
  createLlmModels,
  injectedKind,
  THINKING_OFF_PROVIDER_OPTIONS,
  ToolWaitAnnouncer,
  toolWaitPhrase,
  injectedMessage,
  SUMMARY_PREFIX,
  VOICE_MODE_END,
  VOICE_MODE_INSTRUCTIONS,
  VOICE_RETRY_REMINDER,
  voiceTurnMessages,
  type ToolWaitPhrase,
  type VoiceTimers,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

const NOW = new Date('2026-11-10T10:00:00Z');

/** Minuterie simulée : `advance(ms)` déclenche, dans l'ordre, les rappels échus. */
class FakeTimers implements VoiceTimers {
  #now = 0;
  #seq = 0;
  readonly #pending = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.#now;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.#now + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.#pending.delete(handle);
  };

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#pending) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.#pending.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
    }
    this.#now = target;
  }

  get pending(): number {
    return this.#pending.size;
  }
}

/** Prompt système envoyé au modèle lors de l'appel n° `index`. */
function systemText(model: ReturnType<typeof scriptedModel>, index: number): string {
  const prompt = model.doStreamCalls[index]?.prompt ?? [];
  return JSON.stringify(prompt.filter((m) => m.role === 'system'));
}

function agentFor(ws: string, extra: Partial<ConstructorParameters<typeof Agent>[0]>): Agent {
  return new Agent({
    model: scriptedModel([{ text: 'ok' }]),
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
    now: () => NOW,
    ...extra,
  });
}

describe('mode vocal : consignes du tour', () => {
  it('ajoute les consignes au tour vocal, hors du prompt système', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Il fait beau.' }]);
      const { emit } = collect();
      const result = await agentFor(ws, { model }).runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Quel temps fait-il ?',
        emit,
        voice: true,
      });
      expect(promptText(model, 0)).toContain(VOICE_MODE_INSTRUCTIONS);
      // Le prompt système reste celui d'un tour écrit : cache de préfixe préservé.
      expect(systemText(model, 0)).not.toContain('Mode vocal');
      // Les consignes suivent le message de l'utilisateur, marquées comme message de l'app.
      const roles = result.messages.map((m) => [m.role, injectedKind(m)]);
      expect(roles).toEqual([
        ['user', undefined],
        ['user', 'voice'],
        ['assistant', undefined],
      ]);
    });
  });

  it("n'ajoute rien à un tour écrit ou dicté", async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Bonjour.' }]);
      const { emit } = collect();
      await agentFor(ws, { model }).runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Bonjour',
        emit,
      });
      expect(promptText(model, 0)).not.toContain('Mode vocal');
    });
  });

  it('garde le même prompt système entre un tour écrit et un tour vocal', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Un.' }, { text: 'Deux.' }]);
      const session = new AgentSession(agentFor(ws, { model }), 's');
      const { emit } = collect();
      await session.send('Premier', emit);
      await session.send('Second', emit, undefined, { voice: true });
      expect(systemText(model, 1)).toBe(systemText(model, 0));
      // L'historique du premier tour est repris tel quel : préfixe identique.
      expect(promptText(model, 1)).toContain(VOICE_MODE_INSTRUCTIONS);
      expect(promptText(model, 0)).not.toContain(VOICE_MODE_INSTRUCTIONS);
    });
  });

  it('signale la fin du mode vocal au premier tour écrit qui suit, une seule fois', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { text: 'Oui.' },
        { text: 'Encore oui.' },
        { text: 'Voici le détail.' },
        { text: 'Suite.' },
      ]);
      const session = new AgentSession(agentFor(ws, { model }), 's');
      const { emit } = collect();
      await session.send('Un', emit, undefined, { voice: true });
      await session.send('Deux', emit, undefined, { voice: true });
      await session.send('Trois', emit);
      await session.send('Quatre', emit);
      const kinds = (messages: readonly ModelMessage[]) =>
        messages.map((m) => injectedKind(m)).filter((k) => k !== undefined);
      expect(kinds(session.history)).toEqual(['voice', 'voice', 'voice_end']);
      expect(promptText(model, 2)).toContain(VOICE_MODE_END);
      // Quatrième tour : rien de nouveau (l'historique contient déjà la fin).
      const fourth = model.doStreamCalls[3]?.prompt ?? [];
      expect(JSON.stringify(fourth.at(-1))).toContain('Quatre');
    });
  });
});

describe('mode vocal : compaction et relances', () => {
  it('pas de fin du mode vocal quand la compaction a résumé les tours vocaux', () => {
    const history: ModelMessage[] = [
      injectedMessage('summary', `${SUMMARY_PREFIX}\nL'utilisateur a demandé la météo.`),
      { role: 'user', content: 'Merci' },
      { role: 'assistant', content: [{ type: 'text', text: 'Avec plaisir.' }] },
    ];
    expect(voiceTurnMessages(history, false)).toEqual([]);
  });

  it('ajoute le rappel vocal à une relance de pas vide, pas en tour écrit', async () => {
    await withTempDir(async (ws) => {
      const steps = [
        { toolCalls: [{ name: 'list_dir', input: { path: '.' } }] },
        { text: '' },
        { text: 'Le dossier est vide.' },
      ];
      const voiceModel = scriptedModel(steps);
      const { emit } = collect();
      await agentFor(ws, { model: voiceModel }).runTurn({
        sessionId: 's',
        turnId: 'v',
        history: [],
        input: 'Quoi dans le dossier ?',
        emit,
        voice: true,
      });
      expect(voiceModel.doStreamCalls).toHaveLength(3);
      expect(promptText(voiceModel, 2)).toContain(VOICE_RETRY_REMINDER);

      const textModel = scriptedModel(steps);
      await agentFor(ws, { model: textModel }).runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Quoi dans le dossier ?',
        emit,
      });
      expect(textModel.doStreamCalls).toHaveLength(3);
      expect(promptText(textModel, 2)).not.toContain(VOICE_RETRY_REMINDER);
    });
  });
});

describe('mode vocal : thinking coupé', () => {
  it('utilise le modèle rapide et les options qui coupent le thinking', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Écrit.' }]);
      const fastModel = scriptedModel([{ text: 'Parlé.' }]);
      const agent = agentFor(ws, { model, fastModel });
      const { emit } = collect();
      await agent.runTurn({
        sessionId: 's',
        turnId: 'v',
        history: [],
        input: 'Hé',
        emit,
        voice: true,
      });
      expect(fastModel.doStreamCalls).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(fastModel.doStreamCalls[0]?.providerOptions).toEqual(THINKING_OFF_PROVIDER_OPTIONS);

      await agent.runTurn({ sessionId: 's', turnId: 'w', history: [], input: 'Hé', emit });
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doStreamCalls[0]?.providerOptions).toBeUndefined();
    });
  });

  it('coupe le thinking du vrai provider même sans modèle rapide (réglage thinking activé)', async () => {
    await withTempDir(async (ws) => {
      const bodies: Record<string, unknown>[] = [];
      const fakeFetch = vi.fn((_url: unknown, init?: { body?: unknown }): Promise<Response> => {
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
        );
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'qwen3.5:35b',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const body =
          [chunk({ role: 'assistant', content: 'Oui.' }), chunk({}, 'stop')]
            .map((c) => `data: ${JSON.stringify(c)}\n\n`)
            .join('') + 'data: [DONE]\n\n';
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      });
      const { model } = createLlmModels({
        baseUrl: 'https://llm.example.com',
        model: 'qwen3.5:35b',
        thinking: true,
        fetch: fakeFetch,
      });
      const agent = agentFor(ws, { model });
      const { emit } = collect();
      await agent.runTurn({ sessionId: 's', turnId: 't', history: [], input: 'Oui ?', emit });
      await agent.runTurn({
        sessionId: 's',
        turnId: 'v',
        history: [],
        input: 'Oui ?',
        emit,
        voice: true,
      });
      expect(bodies[0]?.['reasoning_effort']).toBeUndefined();
      expect(bodies[1]?.['reasoning_effort']).toBe('none');
      expect(bodies[1]?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
    });
  });
});

describe('phrases d’attente : libellés', () => {
  it('décrit l’outil sans URL, chemin complet ni commande', () => {
    expect(toolWaitPhrase('read_file', { path: 'data/2026/ventes.csv' })).toBe(
      'Je lis ventes.csv.',
    );
    expect(toolWaitPhrase('web_search', { query: 'météo Liège' })).toBe('Je cherche sur le web.');
    expect(toolWaitPhrase('web_fetch', { url: 'https://example.com/a?b=c' })).toBe(
      'Je lis une page web.',
    );
    expect(toolWaitPhrase('bash', { command: 'python3 -c "print(1)"' })).toBe(
      'Je lance une commande.',
    );
    expect(toolWaitPhrase('grep', { pattern: 'TODO|FIXME' })).toBe('Je cherche dans les fichiers.');
    expect(toolWaitPhrase('write_file', { path: 'rapport.md' })).toBe("J'écris rapport.md.");
    expect(toolWaitPhrase('read_file', { path: 'skills/xlsx/SKILL.md' })).toBe(
      'Je consulte un skill.',
    );
    expect(toolWaitPhrase('read_file', { path: `${'x'.repeat(60)}.csv` })).toBe(
      'Je lis un fichier.',
    );
    expect(toolWaitPhrase('mcp__github__create_issue', {})).toBe("J'utilise le connecteur github.");
    expect(toolWaitPhrase('inconnu', {})).toBe('Je travaille.');
  });
});

describe('phrases d’attente : rythme', () => {
  function announcer() {
    const timers = new FakeTimers();
    const phrases: ToolWaitPhrase[] = [];
    const a = new ToolWaitAnnouncer({ onPhrase: (p) => phrases.push(p), timers });
    return { a, timers, phrases, said: () => phrases.map((p) => p.text) };
  }

  it('ne dit rien pour un outil de moins de 1,5 s', () => {
    const { a, timers, said } = announcer();
    a.start('1', 'read_file', { path: 'ventes.csv' });
    timers.advance(1_499);
    a.end('1');
    timers.advance(10_000);
    expect(said()).toEqual([]);
  });

  it('parle à 1,5 s, une seule fois par outil', () => {
    const { a, timers, phrases } = announcer();
    a.start('1', 'read_file', { path: 'ventes.csv' });
    timers.advance(1_500);
    expect(phrases).toEqual([
      { toolCallId: '1', toolName: 'read_file', text: 'Je lis ventes.csv.' },
    ]);
    timers.advance(20_000);
    expect(phrases).toHaveLength(1);
  });

  it('au plus une phrase toutes les 5 s : la suivante attend la fin de l’écart', () => {
    const { a, timers, said } = announcer();
    a.start('1', 'read_file', { path: 'ventes.csv' });
    timers.advance(2_000); // phrase à 1,5 s
    a.end('1');
    a.start('2', 'web_search', { query: 'x' }); // échu à 3,5 s, autorisé à 6,5 s
    timers.advance(4_000); // t = 6 s
    expect(said()).toEqual(['Je lis ventes.csv.']);
    timers.advance(500); // t = 6,5 s
    expect(said()).toEqual(['Je lis ventes.csv.', 'Je cherche sur le web.']);
  });

  it('se tait si l’outil retenu par l’écart se termine avant', () => {
    const { a, timers, said } = announcer();
    a.start('1', 'read_file', { path: 'a.csv' });
    timers.advance(1_500);
    a.end('1');
    a.start('2', 'web_search', {});
    timers.advance(3_000); // t = 4,5 s : échu mais retenu jusqu'à 6,5 s
    a.end('2');
    timers.advance(10_000);
    expect(said()).toEqual(['Je lis a.csv.']);
  });

  it('enchaîne des outils lents sans dépasser une phrase par fenêtre de 5 s', () => {
    const timers = new FakeTimers();
    const spokenAt: number[] = [];
    const b = new ToolWaitAnnouncer({
      onPhrase: () => spokenAt.push(timers.now()),
      timers,
    });
    for (let i = 0; i < 10; i++) {
      b.start(String(i), 'bash', {});
      timers.advance(2_000);
      b.end(String(i));
    }
    expect(spokenAt.length).toBeGreaterThan(1);
    for (let i = 1; i < spokenAt.length; i++) {
      expect((spokenAt[i] ?? 0) - (spokenAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(5_000);
    }
  });

  it('dispose annule les phrases en attente ; une erreur du récepteur est journalisée', () => {
    const timers = new FakeTimers();
    const onError = vi.fn();
    const a = new ToolWaitAnnouncer({
      onPhrase: () => {
        throw new Error('synthèse indisponible');
      },
      timers,
      onError,
    });
    a.start('1', 'bash', {});
    timers.advance(1_500);
    expect(onError).toHaveBeenCalledOnce();
    a.start('2', 'bash', {});
    a.dispose();
    expect(timers.pending).toBe(0);
    a.start('3', 'bash', {});
    timers.advance(60_000);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('phrases d’attente dans un tour', () => {
  /** Outil dont l'exécution « dure » `ms` sur la minuterie simulée. */
  function slowTool(timers: FakeTimers, name: string, ms: number, permission: 'never' | 'always') {
    return defineTool({
      name,
      description: `Outil lent ${name}`,
      inputSchema: z.object({ path: z.string().optional() }),
      permission,
      source: 'native',
      execute: () => {
        timers.advance(ms);
        return Promise.resolve({ ok: true, content: 'fait' });
      },
    }) as AnyToolDefinition;
  }

  function setup(timers: FakeTimers, decision?: () => PermissionDecision) {
    const registry = createDefaultRegistry();
    registry.register(slowTool(timers, 'web_search', 2_000, 'never'));
    registry.register(slowTool(timers, 'quick_read', 1_000, 'never'));
    registry.register(slowTool(timers, 'guarded_read', 1_000, 'always'));
    // Outil « conditional » qui demande la permission dans `execute` (comme `bash`).
    for (const [name, ms] of [
      ['ask_then_slow', 2_000],
      ['ask_then_quick', 1_000],
    ] as const) {
      registry.register(
        defineTool({
          name,
          description: `Outil ${name}`,
          inputSchema: z.object({ path: z.string().optional() }),
          permission: 'conditional',
          source: 'native',
          execute: async (_input, context) => {
            await context.requestPermission({
              id: `p-${name}`,
              sessionId: context.sessionId,
              toolCallId: context.toolCallId,
              toolName: name,
              kind: 'command',
              title: 'Lancer la commande',
              input: {},
            });
            timers.advance(ms);
            return { ok: true, content: 'fait' };
          },
        }),
      );
    }
    const requestPermission = (): Promise<PermissionDecision> => {
      // L'utilisateur met 3 s à répondre à la modale : ce temps ne compte pas.
      timers.advance(3_000);
      return Promise.resolve(decision?.() ?? 'allow_once');
    };
    return { registry, requestPermission };
  }

  it('émet la phrase d’un outil long en tour vocal, pas d’un outil court', async () => {
    await withTempDir(async (ws) => {
      const timers = new FakeTimers();
      const model = scriptedModel([
        { toolCalls: [{ name: 'quick_read', input: { path: 'a.csv' } }] },
        { toolCalls: [{ name: 'web_search', input: { path: 'docs/ventes.csv' } }] },
        { text: 'Les ventes sont stables.' },
      ]);
      const phrases: ToolWaitPhrase[] = [];
      const agent = agentFor(ws, { model, voiceTimers: timers, ...setup(timers) });
      const { events, emit } = collect();
      await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Résume les ventes',
        emit,
        voice: true,
        onToolWaitPhrase: (p) => phrases.push(p),
      });
      expect(phrases.map((p) => [p.toolName, p.text])).toEqual([
        ['web_search', 'Je cherche sur le web.'],
      ]);
      // Pas un AgentEvent : rien de nouveau dans le flux d'événements.
      expect(new Set(events.map((e) => e.type))).not.toContain('tool_wait');
      expect(timers.pending).toBe(0);
    });
  });

  it('ne compte pas l’attente de la permission', async () => {
    await withTempDir(async (ws) => {
      const timers = new FakeTimers();
      const model = scriptedModel([
        { toolCalls: [{ name: 'guarded_read', input: { path: 'a.csv' } }] },
        { text: 'Fait.' },
      ]);
      const phrases: ToolWaitPhrase[] = [];
      const agent = agentFor(ws, { model, voiceTimers: timers, ...setup(timers) });
      const { emit } = collect();
      await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Lis',
        emit,
        voice: true,
        onToolWaitPhrase: (p) => phrases.push(p),
      });
      expect(phrases).toEqual([]);
    });
  });

  it('suspend la minuterie quand l’outil demande lui-même la permission', async () => {
    await withTempDir(async (ws) => {
      const timers = new FakeTimers();
      const model = scriptedModel([
        { toolCalls: [{ name: 'ask_then_quick', input: {} }] },
        { toolCalls: [{ name: 'ask_then_slow', input: {} }] },
        { text: 'Fait.' },
      ]);
      const spoken: [string, number][] = [];
      const agent = agentFor(ws, { model, voiceTimers: timers, ...setup(timers) });
      const { emit } = collect();
      await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Lance',
        emit,
        voice: true,
        onToolWaitPhrase: (p) => spoken.push([p.toolName, timers.now()]),
      });
      // 3 s de modale puis 1 s d'exécution : rien. 3 s de modale puis 2 s : une phrase,
      // 1,5 s après l'accord (t = 4 s + 3 s + 1,5 s).
      expect(spoken).toEqual([['ask_then_slow', 8_500]]);
      expect(timers.pending).toBe(0);
    });
  });

  it('ne dit rien hors du mode vocal', async () => {
    await withTempDir(async (ws) => {
      const timers = new FakeTimers();
      const model = scriptedModel([
        { toolCalls: [{ name: 'web_search', input: { path: 'a.csv' } }] },
        { text: 'Fait.' },
      ]);
      const onToolWaitPhrase = vi.fn();
      const agent = agentFor(ws, { model, voiceTimers: timers, ...setup(timers) });
      const { emit } = collect();
      await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Lis',
        emit,
        onToolWaitPhrase,
      });
      expect(onToolWaitPhrase).not.toHaveBeenCalled();
    });
  });
});
