// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@atelier/shared';
import { modelChanges } from './MessageList';

const answer = (id: string, model?: string): ChatMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Réponse' }],
  createdAt: '2026-10-30T10:00:00.000Z',
  ...(model !== undefined ? { model } : {}),
});

describe('séparateur « Modèle : X »', () => {
  it('annonce un vrai changement de modèle, pas « atelier » puis « atelier:latest »', () => {
    const changes = modelChanges([
      answer('a0'),
      answer('a1', 'atelier'),
      answer('a2', 'atelier:latest'),
      answer('a3', 'qwen3.5:9b'),
    ]);
    expect([...changes]).toEqual([['a3', 'qwen3.5:9b']]);
  });
});
