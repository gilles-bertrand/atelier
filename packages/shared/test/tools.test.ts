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

describe('ToolDefinition.describePermission', () => {
  it("reçoit l'entrée typée et produit un libellé", () => {
    const createIssue = defineTool({
      name: 'mcp__github__create_issue',
      description: 'Crée une issue.',
      inputSchema: z.object({ title: z.string() }),
      permission: 'always',
      source: 'mcp',
      describePermission: ({ title }) => ({
        kind: 'mcp_write',
        title: `Créer l'issue « ${title} » sur GitHub`,
      }),
      execute: () => Promise.resolve({ ok: false, denied: true, content: 'Refusé.' }),
    });
    const registry = new InMemoryToolRegistry([createIssue]);
    const tool = registry.get('mcp__github__create_issue');
    expect(tool?.describePermission?.({ title: 'Bug login' }).title).toBe(
      "Créer l'issue « Bug login » sur GitHub",
    );
  });
});
