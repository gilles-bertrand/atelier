import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AtelierError, InMemoryToolRegistry, defineTool, mcpToolName } from '../src/index.js';

const echo = defineTool({
  name: 'echo',
  description: 'Renvoie le texte.',
  inputSchema: z.object({ text: z.string() }),
  permission: 'never',
  source: 'native',
  execute: ({ text }) => Promise.resolve({ ok: true, content: text }),
});

describe('InMemoryToolRegistry', () => {
  it('enregistre, liste et retire des outils hétérogènes', () => {
    const count = defineTool({
      name: 'count',
      description: 'Compte.',
      inputSchema: z.object({ n: z.number() }),
      permission: 'always',
      source: 'native',
      execute: ({ n }) => Promise.resolve({ ok: true, content: String(n) }),
    });
    const registry = new InMemoryToolRegistry([echo]);
    registry.register(count);
    expect(registry.list().map((t) => t.name)).toEqual(['echo', 'count']);
    expect(registry.list((t) => t.permission === 'always')).toHaveLength(1);
    expect(registry.unregister('echo')).toBe(true);
    expect(registry.has('echo')).toBe(false);
  });

  it('refuse les doublons et les noms invalides', () => {
    const registry = new InMemoryToolRegistry([echo]);
    expect(() => {
      registry.register(echo);
    }).toThrow(AtelierError);
    expect(() => {
      registry.register({ ...echo, name: 'nom invalide' });
    }).toThrow(/invalide/);
  });
});

describe('mcpToolName', () => {
  it('préfixe et nettoie', () => {
    expect(mcpToolName('git hub', 'create.issue')).toBe('mcp__git_hub__create_issue');
  });
});
