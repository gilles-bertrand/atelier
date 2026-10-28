import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildServerEnv,
  formatCallResult,
  jsonSchemaToZod,
  toCatalogEntry,
  toDynamicTool,
  type McpToolCaller,
  type McpToolInfo,
} from '../src/index.js';
import { makeContext } from './helpers.js';

const createIssue: McpToolInfo = {
  name: 'create_issue',
  title: 'Créer une issue',
  description: 'Crée une issue dans un dépôt GitHub.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { repo: { type: 'string' }, title: { type: 'string' } },
    required: ['repo', 'title'],
  },
};
const listIssues: McpToolInfo = {
  name: 'list issues',
  description: 'Liste les issues.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
};

describe('toCatalogEntry', () => {
  const call = vi.fn<McpToolCaller>(() =>
    Promise.resolve({ content: [{ type: 'text', text: 'Issue #42 créée' }] }),
  );

  it('nomme l’outil mcp__<serveur>__<outil> et préfixe la description', () => {
    const entry = toCatalogEntry('GitHub Pro', createIssue, call);
    expect(entry.definition.name).toBe('mcp__GitHub_Pro__create_issue');
    expect(entry.definition.source).toBe('mcp');
    expect(entry.definition.description).toBe(
      '[Connecteur MCP « GitHub Pro » : Créer une issue] Crée une issue dans un dépôt GitHub.',
    );
    expect(toCatalogEntry('gh', listIssues, call).definition.name).toBe('mcp__gh__list_issues');
  });

  it('écriture par défaut → permission always ; readOnlyHint → never', () => {
    expect(toCatalogEntry('gh', createIssue, call).definition.permission).toBe('always');
    expect(toCatalogEntry('gh', listIssues, call).definition.permission).toBe('never');
  });

  it('décrit la permission en français', () => {
    const entry = toCatalogEntry('gh', createIssue, call);
    expect(entry.definition.describePermission?.({ repo: 'a/b', title: 'Bug' })).toEqual({
      kind: 'mcp_write',
      title: 'Utiliser « Créer une issue » du connecteur gh',
      detail: '{\n  "repo": "a/b",\n  "title": "Bug"\n}',
      scopeKey: 'mcp__gh__create_issue',
    });
  });

  it('valide l’entrée avec le schéma converti', () => {
    const { definition } = toCatalogEntry('gh', createIssue, call);
    expect(definition.inputSchema.safeParse({ repo: 'a/b', title: 'x' }).success).toBe(true);
    expect(definition.inputSchema.safeParse({ repo: 'a/b' }).success).toBe(false);
    // Ce que l'AI SDK enverra au modèle.
    expect(z.toJSONSchema(definition.inputSchema, { io: 'input' })).toMatchObject({
      type: 'object',
      properties: { repo: { type: 'string' }, title: { type: 'string' } },
      required: ['repo', 'title'],
    });
  });

  it('appelle le serveur et renvoie le texte', async () => {
    const { definition } = toCatalogEntry('gh', createIssue, call);
    const { context } = makeContext();
    expect(await definition.execute({ repo: 'a/b', title: 'x' }, context)).toEqual({
      ok: true,
      content: 'Issue #42 créée',
    });
    expect(call).toHaveBeenCalledWith(
      'gh',
      'create_issue',
      { repo: 'a/b', title: 'x' },
      context.abortSignal,
    );
  });

  it('une erreur de transport devient ok: false', async () => {
    const failing = toCatalogEntry('gh', createIssue, () => Promise.reject(new Error('EPIPE')));
    const { context } = makeContext();
    expect(await failing.definition.execute({}, context)).toEqual({
      ok: false,
      content: 'Échec du connecteur gh : EPIPE',
    });
  });
});

describe('jsonSchemaToZod', () => {
  it('se replie sur le JSON Schema d’origine quand la conversion échoue', () => {
    const schema = {
      type: 'object',
      properties: { node: { $ref: '#/definitions/Node' } },
      definitions: { Node: { type: 'object' } },
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.safeParse({ node: { any: 1 } }).success).toBe(true);
    expect(z.toJSONSchema(zod, { io: 'input' })).toMatchObject({
      properties: { node: { $ref: '#/definitions/Node' } },
    });
  });

  it('un schéma absent devient un objet vide', () => {
    expect(jsonSchemaToZod(undefined).safeParse({}).success).toBe(true);
  });
});

describe('formatCallResult', () => {
  it('assemble les contenus', () => {
    expect(
      formatCallResult({
        content: [
          { type: 'text', text: 'Bonjour' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'contenu' } },
          {
            type: 'resource',
            resource: { uri: 'file:///a.bin', blob: 'AAAA', mimeType: 'application/zip' },
          },
          { type: 'resource_link', name: 'rapport', uri: 'file:///r.pdf' },
        ],
      }).content,
    ).toBe(
      'Bonjour\n\n[image image/png renvoyée par le connecteur, non transmise]\n\n' +
        '--- ressource file:///a.txt ---\ncontenu\n\n' +
        '[ressource binaire file:///a.bin (application/zip), non transmise]\n\n' +
        '[lien vers la ressource rapport : file:///r.pdf]',
    );
  });

  it('utilise structuredContent à défaut de contenu', () => {
    expect(formatCallResult({ content: [], structuredContent: { total: 3 } }).content).toBe(
      '{\n  "total": 3\n}',
    );
  });

  it('isError → ok: false', () => {
    expect(
      formatCallResult({ content: [{ type: 'text', text: 'Accès refusé' }], isError: true }),
    ).toEqual({
      ok: false,
      content: 'Accès refusé',
    });
    expect(formatCallResult({ isError: true }).content).toMatch(/erreur sans détail/);
  });

  it('tronque les résultats volumineux', () => {
    const out = formatCallResult({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 10);
    expect(out.content).toBe('xxxxxxxxxx\n\n[… résultat tronqué à 10 caractères]');
  });
});

describe('toDynamicTool', () => {
  it('produit un outil AI SDK dynamique au schéma JSON', async () => {
    const call = vi.fn<McpToolCaller>(() =>
      Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const entry = toCatalogEntry('gh', createIssue, call);
    const tool = toDynamicTool(entry, call);
    expect(tool.type).toBe('dynamic');
    const output: unknown = await tool.execute?.({ repo: 'a/b', title: 't' }, {
      toolCallId: '1',
      messages: [],
    } as never);
    expect(output).toBe('ok');
  });
});

describe('buildServerEnv', () => {
  it('complète le PATH (app lancée depuis le Finder) et applique env', () => {
    const env = buildServerEnv(
      { PATH: '/usr/bin:/bin', HOME: '/Users/alice', SECRET_TOKEN: 'ne-pas-transmettre' },
      ['/opt/homebrew/bin', '/usr/bin'],
      { API_KEY: 'k' },
    );
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin');
    expect(env.HOME).toBe('/Users/alice');
    expect(env.API_KEY).toBe('k');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});
