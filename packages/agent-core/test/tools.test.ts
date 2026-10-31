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
import { guardedPrecheck } from '../src/tools/native.js';
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

  it('list_dir signale les pièces jointes de .atelier/uploads (#59)', async () => {
    await withTempDir(async (ws) => {
      // Dossier vide en apparence : les pièces jointes sont dans le dossier caché.
      await mkdir(path.join(ws, '.atelier/uploads'), { recursive: true });
      await mkdir(path.join(ws, '.atelier/cache'), { recursive: true });
      await writeFile(path.join(ws, '.atelier/uploads/facture.pdf'), '%PDF');
      await writeFile(path.join(ws, '.atelier/uploads/photo.jpg'), 'jpg');
      await writeFile(path.join(ws, '.atelier/cache/abc.txt'), 'cache');
      const empty = await listDirTool.execute({}, ctx(ws));
      expect(empty.content).toBe(
        'Pièces jointes : .atelier/uploads/facture.pdf, .atelier/uploads/photo.jpg',
      );

      await writeFile(path.join(ws, 'notes.md'), 'x');
      const root = await listDirTool.execute({ path: '.' }, ctx(ws));
      expect(root.content).toBe(
        'notes.md (1 o)\n\nPièces jointes : .atelier/uploads/facture.pdf, .atelier/uploads/photo.jpg',
      );

      // Sur .atelier : uploads/ seulement, le cache reste masqué.
      const app = await listDirTool.execute({ path: '.atelier' }, ctx(ws));
      expect(app.content).toContain('uploads/');
      expect(app.content).not.toContain('cache');
      expect(app.content).toContain('Pièces jointes');

      // Un sous-dossier n'est pas concerné.
      await mkdir(path.join(ws, 'docs'));
      expect((await listDirTool.execute({ path: 'docs' }, ctx(ws))).content).toBe('docs est vide.');
    });
  });

  it('list_dir borne la liste des pièces jointes à 20 noms', async () => {
    await withTempDir(async (ws) => {
      await mkdir(path.join(ws, '.atelier/uploads'), { recursive: true });
      for (let i = 0; i < 25; i++) {
        await writeFile(path.join(ws, `.atelier/uploads/f${String(i).padStart(2, '0')}.txt`), 'x');
      }
      const { content } = await listDirTool.execute({}, ctx(ws));
      expect(content.match(/\.atelier\/uploads\//g)).toHaveLength(20);
      expect(content).toMatch(/… et 5 autres$/);
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

describe('vérification préalable (ADR-003, D9)', () => {
  const base = (ws: string) => ({
    sessionId: 's',
    workspace: ws,
    abortSignal: new AbortController().signal,
  });
  const update = {
    name: 'mcp__crm__update',
    description: 'x',
    inputSchema: writeFileTool.inputSchema,
    permission: 'always' as const,
    source: 'mcp' as const,
    execute: () => Promise.resolve({ ok: true, content: 'fait' }),
  };

  it('l’échec passe par limitOutput, comme la sortie d’execute', async () => {
    await withTempDir(async (ws) => {
      const perms = permissions();
      const out = await executeTool(
        { ...update, precheck: () => Promise.resolve({ ok: false as const, content: 'Non.' }) },
        { id: 1 },
        'c1',
        {
          ...base(ws),
          requestPermission: perms,
          limitOutput: (name, output) => ({ ...output, content: `[${name}] ${output.content}` }),
        },
      );
      expect(out).toEqual({ ok: false, content: '[mcp__crm__update] Non.' });
      expect(perms.requests).toHaveLength(0);
    });
  });

  it('guardedPrecheck : refus certains en échec, erreurs passagères relancées (la question est posée)', async () => {
    const fsError = (code: string) =>
      Promise.reject(Object.assign(new Error(`erreur ${code}`), { code }));
    await expect(guardedPrecheck(() => fsError('ENOENT'))).resolves.toEqual({
      ok: false,
      content: 'Fichier ou dossier introuvable.',
    });
    await expect(guardedPrecheck(() => fsError('EMFILE'))).rejects.toThrow('erreur EMFILE');
    await expect(guardedPrecheck(() => fsError('EBUSY'))).rejects.toThrow('erreur EBUSY');
    // Dans executeTool, l'erreur passagère ne conclut pas : la question est posée.
    await withTempDir(async (ws) => {
      const perms = permissions();
      const out = await executeTool(
        { ...update, precheck: () => guardedPrecheck(() => fsError('EMFILE')) },
        { id: 1 },
        'c1',
        { ...base(ws), requestPermission: perms },
      );
      expect(out).toEqual({ ok: true, content: 'fait' });
      expect(perms.requests).toHaveLength(1);
    });
  });

  it('une exception dans precheck laisse poser la question, puis execute décide', async () => {
    await withTempDir(async (ws) => {
      const perms = permissions();
      const out = await executeTool(
        { ...update, precheck: () => Promise.reject(new Error('bug de vérification')) },
        { id: 1 },
        'c1',
        { ...base(ws), requestPermission: perms },
      );
      expect(out).toEqual({ ok: true, content: 'fait' });
      expect(perms.requests).toHaveLength(1);
    });
  });

  it("l'annulation du tour pendant precheck est propagée, sans question", async () => {
    await withTempDir(async (ws) => {
      const controller = new AbortController();
      const perms = permissions();
      const run = executeTool(
        {
          ...update,
          precheck: () => {
            controller.abort();
            return Promise.reject(new Error('tour annulé'));
          },
        },
        { id: 1 },
        'c1',
        { ...base(ws), abortSignal: controller.signal, requestPermission: perms },
      );
      await expect(run).rejects.toThrow('tour annulé');
      expect(perms.requests).toHaveLength(0);
    });
  });

  it('l’échec est recopié sans « denied » ni « display », et ignoré hors des outils « always »', async () => {
    await withTempDir(async (ws) => {
      const perms = permissions();
      const failure = {
        ok: false as const,
        content: 'Non.',
        denied: true,
        display: { type: 'diff' as const, path: 'x', before: '', after: '' },
      };
      const checked = { ...update, precheck: () => Promise.resolve(failure) };
      const out = await executeTool(checked, { id: 1 }, 'c1', {
        ...base(ws),
        requestPermission: perms,
      });
      expect(out).toEqual({ ok: false, content: 'Non.' });
      expect(perms.requests).toHaveLength(0);
      // `never` : aucune question, donc aucune vérification préalable ; execute décide.
      const never = await executeTool(
        { ...checked, permission: 'never' as const },
        { id: 2 },
        'c2',
        {
          ...base(ws),
          requestPermission: perms,
        },
      );
      expect(never).toEqual({ ok: true, content: 'fait' });
    });
  });
});
