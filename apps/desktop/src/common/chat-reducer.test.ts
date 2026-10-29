import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage } from '@atelier/shared';
import {
  applyAgentEvent,
  createAssistantMessage,
  createUserMessage,
  deriveSessionTitle,
  latestTodos,
  settleRunningTools,
  userModelText,
} from './chat-reducer.js';

const base = { sessionId: 's1', turnId: 't1' } as const;
const empty = (): ChatMessage =>
  createAssistantMessage({ id: 'a1', sessionId: 's1', createdAt: '2026-10-28T10:00:00.000Z' });
const reduce = (events: AgentEvent[]): ChatMessage => events.reduce(applyAgentEvent, empty());

describe('applyAgentEvent', () => {
  it('concatène les fragments de texte et sépare le raisonnement', () => {
    const message = reduce([
      { ...base, type: 'reasoning_delta', delta: 'Je ' },
      { ...base, type: 'reasoning_delta', delta: 'réfléchis' },
      { ...base, type: 'text_delta', delta: 'Bon' },
      { ...base, type: 'text_delta', delta: 'jour' },
    ]);
    expect(message.parts).toEqual([
      { type: 'reasoning', text: 'Je réfléchis' },
      { type: 'text', text: 'Bonjour' },
    ]);
  });

  it('ajoute les fichiers produits par un outil (tool_files), sans doublon de chemin', () => {
    const created = {
      path: 'recap.xlsx',
      absolutePath: '/w/recap.xlsx',
      action: 'created',
    } as const;
    const message = reduce([
      { ...base, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} },
      { ...base, type: 'tool_files', toolCallId: 'c1', files: [created] },
      {
        ...base,
        type: 'tool_files',
        toolCallId: 'c1',
        files: [
          { ...created, action: 'modified' },
          { path: 'resume.md', absolutePath: '/w/resume.md', action: 'created' },
        ],
      },
    ]);
    const part = message.parts[0];
    expect(part?.type === 'tool_call' ? part.files : undefined).toEqual([
      { ...created, action: 'modified' },
      { path: 'resume.md', absolutePath: '/w/resume.md', action: 'created' },
    ]);
  });

  it('suit un appel d’outil du début au résultat (display final prioritaire)', () => {
    const message = reduce([
      {
        ...base,
        type: 'tool_start',
        toolCallId: 'c1',
        toolName: 'write_file',
        input: { path: 'a.md' },
      },
      {
        ...base,
        type: 'tool_display',
        toolCallId: 'c1',
        display: { type: 'command', command: 'x', exitCode: 0, output: '' },
      },
      {
        ...base,
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'write_file',
        ok: true,
        output: 'écrit',
        display: {
          type: 'file',
          file: { path: 'a.md', absolutePath: '/w/a.md', action: 'created' },
        },
      },
    ]);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({
      type: 'tool_call',
      status: 'success',
      output: 'écrit',
      display: { type: 'file' },
    });
  });

  it('marque un refus de permission comme « denied »', () => {
    const message = reduce([
      { ...base, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} },
      {
        ...base,
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        ok: false,
        denied: true,
        output: 'refusé',
      },
    ]);
    expect(message.parts[0]).toMatchObject({ status: 'denied' });
  });

  it('fusionne les sources sans doublon', () => {
    const a = { title: 'A', url: 'https://a.fr', snippet: '' };
    const b = { title: 'B', url: 'https://b.fr', snippet: '' };
    const message = reduce([
      { ...base, type: 'sources', sources: [a] },
      { ...base, type: 'sources', sources: [a, b] },
    ]);
    expect(message.parts).toEqual([{ type: 'sources', sources: [a, b] }]);
  });

  it('ignore les événements sans contenu', () => {
    const before = empty();
    expect(applyAgentEvent(before, { ...base, type: 'done', reason: 'stop' })).toBe(before);
  });
});

describe('utilitaires', () => {
  it('settleRunningTools ferme les outils restés en cours', () => {
    const message = reduce([
      { ...base, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} },
    ]);
    expect(settleRunningTools(message).parts[0]).toMatchObject({
      status: 'error',
      output: 'Interrompu.',
    });
  });

  it('latestTodos garde la dernière liste non vide', () => {
    const todos = [{ id: '1', title: 'Lire', status: 'completed' as const }];
    const withTodos = (list: typeof todos): ChatMessage => ({
      ...empty(),
      parts: [
        {
          type: 'tool_call',
          toolCallId: 'x',
          toolName: 'todo_write',
          input: {},
          status: 'success',
          display: { type: 'todos', todos: list },
        },
      ],
    });
    expect(latestTodos([withTodos(todos), withTodos([])])).toEqual(todos);
    expect(latestTodos([])).toEqual([]);
  });

  it('deriveSessionTitle tronque et nettoie', () => {
    expect(deriveSessionTitle('  Bonjour\n  le monde ')).toBe('Bonjour le monde');
    expect(deriveSessionTitle('x'.repeat(80))).toHaveLength(60);
    expect(deriveSessionTitle('', 'facture.pdf')).toBe('facture.pdf');
  });

  it('createUserMessage et userModelText mentionnent les pièces jointes', () => {
    const attachment = { path: '.atelier/uploads/f.pdf', name: 'f.pdf', size: 10 };
    const message = createUserMessage({
      id: 'u',
      sessionId: 's',
      text: 'Résume',
      attachments: [attachment],
      createdAt: '',
    });
    expect(message.parts.map((p) => p.type)).toEqual(['text', 'attachment']);
    expect(userModelText('Résume', [attachment])).toBe(
      'Résume\n\n[Pièce jointe : .atelier/uploads/f.pdf]',
    );
  });
});
