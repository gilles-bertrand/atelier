import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolExecutionContext } from '@atelier/shared';
import {
  bashTool,
  createDefaultRegistry,
  editFileTool,
  executeTool,
  globTool,
  globToRegExp,
  grepTool,
  isWhitelistedCommand,
  listDirTool,
  LocalSandbox,
  presentFileTool,
  readFileTool,
  todoWriteTool,
  truncateOutput,
  withSessionMemory,
  writeFileTool,
} from '../src/index.js';
import { permissions, withTempDir } from './helpers.js';

function ctx(workspace: string, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 's',
    toolCallId: 'c',
    workspace,
    abortSignal: new AbortController().signal,
    requestPermission: permissions(),
    ...extra,
  };
}

describe('outils fichiers', () => {
  it('write_file crée les dossiers parents et renvoie une carte de fichier', async () => {
    await withTempDir(async (ws) => {
      const out = await writeFileTool.execute({ path: 'notes/a.md', content: '# Titre' }, ctx(ws));
      expect(out.ok).toBe(true);
      expect(await readFile(path.join(ws, 'notes/a.md'), 'utf8')).toBe('# Titre');
      expect(out.display).toMatchObject({
        type: 'file',
        file: { path: 'notes/a.md', action: 'created' },
      });
      const again = await writeFileTool.execute({ path: 'notes/a.md', content: 'v2' }, ctx(ws));
      expect(again.display).toMatchObject({ file: { action: 'modified' } });
    });
  });

  it("refuse d'écrire hors du dossier (sans exception)", async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      await mkdir(ws);
      await symlink(root, path.join(ws, 'parent'));
      for (const p of ['../x.txt', '/tmp/x.txt', 'parent/x.txt']) {
        const out = await writeFileTool.execute({ path: p, content: 'x' }, ctx(ws));
        expect(out.ok).toBe(false);
        expect(out.content).toMatch(/en dehors du dossier de travail/);
      }
    });
  });

  it('edit_file remplace une occurrence unique, refuse une occurrence multiple ou absente', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'f.txt'), 'alpha beta\nalpha gamma\n');
      const multiple = await editFileTool.execute(
        { path: 'f.txt', old_str: 'alpha', new_str: 'A' },
        ctx(ws),
      );
      expect(multiple.ok).toBe(false);
      expect(multiple.content).toMatch(/apparaît 2 fois/);
      const missing = await editFileTool.execute(
        { path: 'f.txt', old_str: 'delta', new_str: 'D' },
        ctx(ws),
      );
      expect(missing.ok).toBe(false);
      expect(missing.content).toMatch(/introuvable/);
      const ok = await editFileTool.execute(
        { path: 'f.txt', old_str: 'alpha gamma', new_str: 'ALPHA GAMMA' },
        ctx(ws),
      );
      expect(ok.ok).toBe(true);
      expect(await readFile(path.join(ws, 'f.txt'), 'utf8')).toBe('alpha beta\nALPHA GAMMA\n');
      expect(ok.display).toMatchObject({ type: 'diff', path: 'f.txt' });
      // Le contenu de remplacement contenant `$&` n'est pas interprété.
      await editFileTool.execute({ path: 'f.txt', old_str: 'beta', new_str: '$& $1' }, ctx(ws));
      expect(await readFile(path.join(ws, 'f.txt'), 'utf8')).toContain('alpha $& $1');
    });
  });

  it('read_file numérote les lignes et gère offset/limit', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'f.txt'), 'un\ndeux\ntrois\nquatre');
      const out = await readFileTool.execute({ path: 'f.txt', offset: 2, limit: 2 }, ctx(ws));
      expect(out.content).toContain('[lignes 2-3 sur 4]');
      expect(out.content).toMatch(/2\tdeux\n\s+3\ttrois/);
      await writeFile(path.join(ws, 'bin.dat'), Buffer.from([1, 0, 2]));
      expect((await readFileTool.execute({ path: 'bin.dat' }, ctx(ws))).ok).toBe(false);
    });
  });

  it('list_dir, glob et grep explorent le dossier', async () => {
    await withTempDir(async (ws) => {
      await mkdir(path.join(ws, 'rapports/2026'), { recursive: true });
      await mkdir(path.join(ws, 'node_modules/x'), { recursive: true });
      await writeFile(
        path.join(ws, 'rapports/2026/q1.md'),
        'Chiffre d affaires : 120 k€\nMarge : 30 %',
      );
      await writeFile(path.join(ws, 'rapports/budget.csv'), 'poste,montant\nloyer,1200');
      await writeFile(path.join(ws, 'node_modules/x/q.md'), 'Chiffre ignoré');
      await mkdir(path.join(ws, '.atelier/cache'), { recursive: true });
      await writeFile(path.join(ws, '.atelier/cache/rendu.md'), 'Chiffre en cache');
      await writeFile(path.join(ws, '.cache'), 'caché');

      const list = await listDirTool.execute({}, ctx(ws));
      expect(list.content).toBe('node_modules/\nrapports/');
      expect((await listDirTool.execute({ show_hidden: true }, ctx(ws))).content).toContain(
        '.cache',
      );

      const md = await globTool.execute({ pattern: '*.md' }, ctx(ws));
      expect(md.content).toBe('rapports/2026/q1.md');
      const both = await globTool.execute({ pattern: '*.{md,csv}', path: 'rapports' }, ctx(ws));
      expect(both.content.split('\n').sort()).toEqual([
        'rapports/2026/q1.md',
        'rapports/budget.csv',
      ]);

      const grep = await grepTool.execute({ pattern: 'chiffre', case_insensitive: true }, ctx(ws));
      expect(grep.content).toBe('rapports/2026/q1.md:1: Chiffre d affaires : 120 k€');
      const filtered = await grepTool.execute({ pattern: 'loyer', include: '*.md' }, ctx(ws));
      expect(filtered.content).toBe('Aucune correspondance.');
      expect((await grepTool.execute({ pattern: '(' }, ctx(ws))).ok).toBe(false);
      expect((await listDirTool.execute({ path: '..' }, ctx(ws))).ok).toBe(false);
    });
  });

  it('todo_write renvoie un affichage todos ; present_file une carte', async () => {
    await withTempDir(async (ws) => {
      const todos = [
        { id: '1', title: 'Lire', status: 'completed' as const },
        { id: '2', title: 'Rédiger', status: 'in_progress' as const },
      ];
      const out = await todoWriteTool.execute({ todos }, ctx(ws));
      expect(out.content).toContain('1/2');
      expect(out.display).toEqual({ type: 'todos', todos });

      await writeFile(path.join(ws, 'r.pdf'), 'x');
      const displays: unknown[] = [];
      const presented = await presentFileTool.execute(
        { path: 'r.pdf' },
        ctx(ws, { emitDisplay: (d) => displays.push(d) }),
      );
      expect(presented.display).toMatchObject({
        type: 'file',
        file: { path: 'r.pdf', mimeType: 'application/pdf', action: 'presented' },
      });
      expect(displays).toHaveLength(1);
      expect((await presentFileTool.execute({ path: 'absent.pdf' }, ctx(ws))).ok).toBe(false);
    });
  });
});

describe('permissions', () => {
  it("executeTool demande la permission pour les outils 'always' et renvoie un refus au lieu d'exécuter", async () => {
    await withTempDir(async (ws) => {
      const deny = permissions('deny');
      const out = await executeTool(writeFileTool, { path: 'x.txt', content: 'x' }, 'c1', {
        sessionId: 's',
        workspace: ws,
        abortSignal: new AbortController().signal,
        requestPermission: deny,
      });
      expect(out).toMatchObject({ ok: false, denied: true });
      expect(out.content).toMatch(/refusé/);
      expect(deny.requests[0]).toMatchObject({
        toolName: 'write_file',
        kind: 'file_write',
        title: 'Écrire le fichier x.txt',
        toolCallId: 'c1',
        scopeKey: 'write_file',
      });
      await expect(readFile(path.join(ws, 'x.txt'))).rejects.toThrow();
    });
  });

  it('un gestionnaire de permission en échec vaut refus (pas une erreur d’outil)', async () => {
    await withTempDir(async (ws) => {
      const out = await executeTool(writeFileTool, { path: 'x.txt', content: 'x' }, 'c1', {
        sessionId: 's',
        workspace: ws,
        abortSignal: new AbortController().signal,
        requestPermission: () => Promise.reject(new Error('fenêtre fermée')),
      });
      expect(out).toMatchObject({ ok: false, denied: true });
      expect(out.content).toMatch(/ni par un autre moyen/);
    });
  });

  it('libellé de permission : outil, puis application, puis repli générique', async () => {
    await withTempDir(async (ws) => {
      const base = {
        sessionId: 's',
        workspace: ws,
        abortSignal: new AbortController().signal,
      };
      const app = (name: string) =>
        name === 'mcp__github__create_issue'
          ? { kind: 'mcp_write' as const, title: 'Libellé application', scopeKey: 'gh' }
          : undefined;
      const perms = permissions('deny');
      // 1. L'outil fournit son libellé : il l'emporte sur celui de l'application.
      await executeTool(writeFileTool, { path: 'a.md', content: 'x' }, 'c1', {
        ...base,
        requestPermission: perms,
        describePermission: () => ({ kind: 'other', title: 'Ne doit pas servir' }),
      });
      // 2. Outil sans libellé : celui de l'application.
      const mcp = {
        name: 'mcp__github__create_issue',
        description: 'x',
        inputSchema: writeFileTool.inputSchema,
        permission: 'always' as const,
        source: 'mcp' as const,
        execute: () => Promise.resolve({ ok: true, content: 'créée' }),
      };
      await executeTool(mcp, { title: 'Bug' }, 'c2', {
        ...base,
        requestPermission: perms,
        describePermission: app,
      });
      // 3. Ni l'un ni l'autre : repli générique.
      await executeTool({ ...mcp, name: 'mcp__drive__delete' }, { id: 1 }, 'c3', {
        ...base,
        requestPermission: perms,
        describePermission: app,
      });
      expect(perms.requests.map((r) => [r.title, r.kind, r.scopeKey])).toEqual([
        ['Écrire le fichier a.md', 'file_write', 'write_file'],
        ['Libellé application', 'mcp_write', 'gh'],
        ["Utiliser l'outil mcp__drive__delete", 'mcp_write', 'mcp__drive__delete'],
      ]);
    });
  });

  it('un describePermission qui lève ou renvoie un libellé vide passe au niveau suivant', async () => {
    await withTempDir(async (ws) => {
      const perms = permissions('deny');
      const broken = {
        name: 'mcp__crm__update',
        description: 'x',
        inputSchema: writeFileTool.inputSchema,
        permission: 'always' as const,
        source: 'mcp' as const,
        describePermission: (): never => {
          throw new Error('bug du serveur MCP');
        },
        execute: () => Promise.resolve({ ok: true, content: 'fait' }),
      };
      const base = { sessionId: 's', workspace: ws, abortSignal: new AbortController().signal };
      const out = await executeTool(broken, { id: 1 }, 'c1', { ...base, requestPermission: perms });
      // L'appel n'échoue pas : la permission est demandée avec le libellé générique.
      expect(out).toMatchObject({ ok: false, denied: true });
      await executeTool(
        { ...broken, describePermission: () => ({ kind: 'other' as const, title: '  ' }) },
        { id: 2 },
        'c2',
        {
          ...base,
          requestPermission: perms,
          describePermission: () => ({ kind: 'mcp_write', title: 'Mettre à jour le CRM' }),
        },
      );
      expect(perms.requests.map((r) => r.title)).toEqual([
        "Utiliser l'outil mcp__crm__update",
        'Mettre à jour le CRM',
      ]);
    });
  });

  it('withSessionMemory mémorise allow_session par scopeKey', async () => {
    const inner = permissions('allow_session');
    const handler = withSessionMemory(inner);
    const req = {
      id: '1',
      sessionId: 's',
      toolCallId: 'c',
      toolName: 'bash',
      kind: 'command' as const,
      title: 't',
      scopeKey: 'bash',
      input: {},
    };
    expect(await handler(req)).toBe('allow_session');
    expect(await handler({ ...req, id: '2' })).toBe('allow_session');
    expect(inner.requests).toHaveLength(1);
  });
});

describe('bash', () => {
  it('liste blanche : lecture seule, sans redirection ni chaînage', () => {
    expect(isWhitelistedCommand('ls -la')).toBe(true);
    expect(isWhitelistedCommand('cat a.txt | grep foo | wc -l')).toBe(true);
    expect(isWhitelistedCommand('rm -rf /')).toBe(false);
    expect(isWhitelistedCommand('ls; rm x')).toBe(false);
    expect(isWhitelistedCommand('ls && rm x')).toBe(false);
    expect(isWhitelistedCommand('cat a > b')).toBe(false);
    expect(isWhitelistedCommand('echo $(rm x)')).toBe(false);
    expect(isWhitelistedCommand('cat `rm x`')).toBe(false);
    expect(isWhitelistedCommand('ls || rm x')).toBe(false);
    expect(isWhitelistedCommand('sort -o out.txt in.txt')).toBe(false);
    expect(isWhitelistedCommand('')).toBe(false);
    // Lecture hors du dossier : permission requise même pour une commande de lecture.
    expect(isWhitelistedCommand('cat /etc/passwd')).toBe(false);
    expect(isWhitelistedCommand('ls ../..')).toBe(false);
    expect(isWhitelistedCommand('head ~/.ssh/id_rsa')).toBe(false);
    expect(isWhitelistedCommand('cat /workspace/a.txt /skills/x/SKILL.md')).toBe(true);
    expect(isWhitelistedCommand('grep -r foo docs/')).toBe(true);
  });

  it('exécute via la Sandbox, demande la permission hors liste blanche', async () => {
    await withTempDir(async (ws) => {
      const sandbox = new LocalSandbox(ws);
      await writeFile(path.join(ws, 'a.txt'), 'bonjour\n');
      const perms = permissions('allow_once');
      const read = await bashTool.execute(
        { command: 'cat a.txt' },
        ctx(ws, { sandbox, requestPermission: perms }),
      );
      expect(read.ok).toBe(true);
      expect(read.content).toContain('bonjour');
      expect(perms.requests).toHaveLength(0);

      const write = await bashTool.execute(
        { command: 'echo salut > b.txt && cat b.txt' },
        ctx(ws, { sandbox, requestPermission: perms }),
      );
      expect(perms.requests).toHaveLength(1);
      expect(perms.requests[0]).toMatchObject({
        kind: 'command',
        detail: 'echo salut > b.txt && cat b.txt',
      });
      expect(write.content).toContain('salut');
      expect(write.display).toMatchObject({ type: 'command', exitCode: 0 });

      const denied = await bashTool.execute(
        { command: 'touch c.txt' },
        ctx(ws, { sandbox, requestPermission: permissions('deny') }),
      );
      expect(denied).toMatchObject({ ok: false, denied: true });

      const failing = await bashTool.execute({ command: 'ls nope' }, ctx(ws, { sandbox }));
      expect(failing.ok).toBe(false);
      expect(failing.content).toMatch(/\[code de sortie : [1-9]/);
    });
  });

  it('sans sandbox, renvoie un message clair', async () => {
    await withTempDir(async (ws) => {
      const out = await bashTool.execute({ command: 'ls' }, ctx(ws));
      expect(out.ok).toBe(false);
      expect(out.content).toMatch(/machine virtuelle/);
    });
  });

  it('LocalSandbox tronque la sortie, respecte le délai et mappe les chemins', async () => {
    await withTempDir(async (ws) => {
      const sandbox = new LocalSandbox(ws);
      const big = await sandbox.exec('yes x | head -c 50000', { maxOutputBytes: 1000 });
      expect(big.stdout.length).toBe(1000);
      expect(big.truncated).toBe(true);
      const slow = await sandbox.exec('sleep 5', { timeoutMs: 100 });
      expect(slow.timedOut).toBe(true);
      expect(slow.exitCode).toBeNull();
      expect(sandbox.toGuestPath(path.join(ws, 'a/b.txt'))).toBe('/workspace/a/b.txt');
      expect(sandbox.toHostPath('/workspace/a/../../etc')).toBeNull();
      expect(sandbox.toGuestPath('/etc/passwd')).toBeNull();
    });
  });
});

describe('utilitaires', () => {
  it('globToRegExp', () => {
    expect(globToRegExp('*.md').test('a/b/c.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/x/a.md')).toBe(false);
    expect(globToRegExp('docs/**/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/**/*.md').test('docs/x/y/a.md')).toBe(true);
    expect(globToRegExp('f?.txt').test('f1.txt')).toBe(true);
  });

  it('truncateOutput', () => {
    expect(truncateOutput('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const t = truncateOutput('é'.repeat(10), 5);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith('éé')).toBe(true);
    expect(t.text).not.toContain('�');
  });

  it('createDefaultRegistry : natifs + bash, un outil fourni remplace le natif', () => {
    const registry = createDefaultRegistry([{ ...readFileTool, description: 'documents' }]);
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'bash',
      'edit_file',
      'glob',
      'grep',
      'list_dir',
      'present_file',
      'read_file',
      'todo_write',
      'write_file',
    ]);
    expect(registry.get('read_file')?.description).toBe('documents');
  });
});
