/**
 * Projets (ADR-003) : dossiers multiples (résolution, outils natifs), prompt
 * (dossiers, consignes, mémoire, artefacts), outils de mémoire et de
 * publication, politique des runs planifiés.
 */
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AtelierError,
  MAX_ARTIFACT_BYTES,
  MEMORY_PROMPT_CHARS,
  type AnyToolDefinition,
  type ArtifactCard,
  type DeniedAction,
  type PermissionRequest,
  type ScheduledPermissions,
  type ToolExecutionContext,
  type WorkspaceFolder,
} from '@atelier/shared';
import {
  appendMemoryNote,
  ARTIFACT_CHART_LIB,
  buildSystemPrompt,
  createAgentRuntime,
  createMemoryTools,
  createPublishArtifactTool,
  editFileTool,
  executeTool,
  externalResources,
  globTool,
  listDirTool,
  MEMORY_NOTES_HEADING,
  presentFileTool,
  resolveFolderPath,
  unattendedPermissionHandler,
  writeFileTool,
  type ArtifactPublisher,
  type ArtifactPublishRequest,
  type ProjectMemoryWriter,
  type PromptProject,
  type ToolRuntime,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

interface Fixture {
  root: string;
  primary: string;
  compta: string;
  archives: string;
  folders: WorkspaceFolder[];
}

/** Projet de test : principal, « Compta » (écriture) et « Archives » (lecture seule). */
function withProject<T>(fn: (p: Fixture) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const root = await realpath(dir);
    const primary = path.join(root, 'Projet');
    const compta = path.join(root, 'Compta');
    const archives = path.join(root, 'Archives');
    for (const d of [primary, compta, archives]) await mkdir(d);
    const folders: WorkspaceFolder[] = [
      { path: compta, label: 'Compta', access: 'write', guestPath: '/dossiers/Compta' },
      { path: archives, label: 'Archives', access: 'read', guestPath: '/dossiers/Archives' },
    ];
    return fn({ root, primary, compta, archives, folders });
  });
}

function ctx(p: Fixture, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 's',
    toolCallId: 'c',
    workspace: p.primary,
    folders: p.folders,
    abortSignal: new AbortController().signal,
    requestPermission: permissions(),
    ...extra,
  };
}

describe('resolveFolderPath', () => {
  it('un chemin relatif part du dossier principal', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.primary, 'a.md'), 'a');
      const found = await resolveFolderPath(ctx(p), 'a.md');
      expect(found).toMatchObject({ relativePath: 'a.md', exists: true, readOnly: false });
      expect(found.folder).toBeUndefined();
      const created = await resolveFolderPath(ctx(p), 'nouveau/b.md', { write: true });
      expect(created.absolutePath).toBe(path.join(p.primary, 'nouveau/b.md'));
      expect(created.exists).toBe(false);
    });
  });

  it('« Compta/… » désigne le dossier rattaché quand le principal n’a pas de Compta', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.compta, 'bilan.csv'), 'x');
      const found = await resolveFolderPath(ctx(p), 'Compta/bilan.csv');
      expect(found.absolutePath).toBe(path.join(p.compta, 'bilan.csv'));
      expect(found.relativePath).toBe('Compta/bilan.csv');
      expect(found.folder?.label).toBe('Compta');
      // Libellé sans tenir compte de la casse, fichier à créer compris.
      const created = await resolveFolderPath(ctx(p), 'compta/2026/note.md', { write: true });
      expect(created.absolutePath).toBe(path.join(p.compta, '2026/note.md'));
      expect(created.relativePath).toBe('Compta/2026/note.md');
      // Le dossier lui-même.
      expect((await resolveFolderPath(ctx(p), 'Compta')).absolutePath).toBe(p.compta);
    });
  });

  it('un sous-dossier du principal qui porte le même nom reste prioritaire', async () => {
    await withProject(async (p) => {
      await mkdir(path.join(p.primary, 'Compta'));
      const found = await resolveFolderPath(ctx(p), 'Compta/x.md', { write: true });
      expect(found.absolutePath).toBe(path.join(p.primary, 'Compta/x.md'));
      expect(found.folder).toBeUndefined();
    });
  });

  it('accepte un chemin absolu dans un dossier rattaché et refuse le reste, en listant les dossiers', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.archives, 'vieux.txt'), 'v');
      const found = await resolveFolderPath(ctx(p), path.join(p.archives, 'vieux.txt'));
      expect(found).toMatchObject({ relativePath: 'Archives/vieux.txt', readOnly: true });
      const outside = resolveFolderPath(ctx(p), path.join(p.root, 'ailleurs.txt'));
      await expect(outside).rejects.toMatchObject({ code: 'tool/path_outside_workspace' });
      await expect(outside).rejects.toThrow(/Compta \(.*\).*Archives \(.*lecture seule\)/);
    });
  });

  it('ramène les chemins de la VM (/workspace, /dossiers/<nom>) au chemin hôte', async () => {
    await withProject(async (p) => {
      expect((await resolveFolderPath(ctx(p), '/workspace/a.txt')).absolutePath).toBe(
        path.join(p.primary, 'a.txt'),
      );
      const archived = await resolveFolderPath(ctx(p), '/dossiers/Archives/b.txt');
      expect(archived.absolutePath).toBe(path.join(p.archives, 'b.txt'));
      expect(archived.folder?.label).toBe('Archives');
    });
  });

  it('refuse l’écriture dans un dossier en lecture seule, pas la lecture', async () => {
    await withProject(async (p) => {
      await expect(
        resolveFolderPath(ctx(p), 'Archives/x.txt', { write: true }),
      ).rejects.toMatchObject({ code: 'tool/read_only' });
      await expect(
        resolveFolderPath(ctx(p), path.join(p.archives, 'x.txt'), { write: true }),
      ).rejects.toMatchObject({ code: 'tool/read_only' });
      await expect(resolveFolderPath(ctx(p), 'Archives/x.txt')).resolves.toMatchObject({
        readOnly: true,
      });
    });
  });

  it('ne sort pas d’un dossier rattaché par « .. » ni par un lien symbolique', async () => {
    await withProject(async (p) => {
      await expect(resolveFolderPath(ctx(p), 'Compta/../../secret')).rejects.toMatchObject({
        code: 'tool/path_outside_workspace',
      });
      await mkdir(path.join(p.root, 'secret'));
      await symlink(path.join(p.root, 'secret'), path.join(p.compta, 'lien'));
      await expect(resolveFolderPath(ctx(p), 'Compta/lien/x.txt')).rejects.toMatchObject({
        code: 'tool/path_outside_workspace',
      });
    });
  });

  it('refuse l’écriture dans un dossier en lecture seule atteint par un autre chemin', async () => {
    await withProject(async (p) => {
      // « Sous » est un sous-dossier du principal, rattaché en lecture seule par un lien.
      await mkdir(path.join(p.primary, 'sous'));
      const link = path.join(p.root, 'lien-sous');
      await symlink(path.join(p.primary, 'sous'), link);
      const context = ctx(p, {
        folders: [...p.folders, { path: link, label: 'Sous', access: 'read' }],
      });
      await expect(resolveFolderPath(context, 'sous/x.md', { write: true })).rejects.toMatchObject({
        code: 'tool/read_only',
      });
      await expect(
        resolveFolderPath(context, path.join(p.primary, 'sous', 'x.md'), { write: true }),
      ).rejects.toMatchObject({ code: 'tool/read_only' });
      await expect(resolveFolderPath(context, 'sous/x.md')).resolves.toMatchObject({
        exists: false,
      });
    });
  });

  it('sans dossiers rattachés, garde le comportement d’un seul dossier', async () => {
    await withProject(async (p) => {
      const single = ctx(p, { folders: [] });
      await expect(
        resolveFolderPath(single, path.join(p.compta, 'x.md'), { write: true }),
      ).rejects.toThrow(/en dehors du dossier de travail/);
      await expect(resolveFolderPath(single, 'Compta/x.md')).resolves.toMatchObject({
        relativePath: 'Compta/x.md',
      });
    });
  });

  it('lit encore les skills (racine en lecture seule) en dehors des dossiers', async () => {
    await withProject(async (p) => {
      const skills = path.join(p.root, 'skills');
      await mkdir(path.join(skills, 'xlsx'), { recursive: true });
      await writeFile(path.join(skills, 'xlsx/SKILL.md'), '# xlsx');
      const found = await resolveFolderPath(ctx(p), path.join(skills, 'xlsx/SKILL.md'), {
        readRoots: [{ host: skills, guest: '/skills' }],
      });
      expect(found).toMatchObject({ readOnly: true, exists: true });
      await expect(
        resolveFolderPath(ctx(p), path.join(skills, 'xlsx/SKILL.md'), {
          write: true,
          readRoots: [{ host: skills }],
        }),
      ).rejects.toMatchObject({ code: 'tool/path_outside_workspace' });
    });
  });
});

describe('outils natifs dans un projet', () => {
  it('write_file écrit dans un dossier rattaché, carte préfixée par son libellé', async () => {
    await withProject(async (p) => {
      const out = await writeFileTool.execute(
        { path: 'Compta/notes/a.md', content: '# A' },
        ctx(p),
      );
      expect(out.ok).toBe(true);
      expect(await readFile(path.join(p.compta, 'notes/a.md'), 'utf8')).toBe('# A');
      expect(out.display).toMatchObject({
        type: 'file',
        file: {
          path: 'Compta/notes/a.md',
          absolutePath: path.join(p.compta, 'notes/a.md'),
          action: 'created',
        },
      });
    });
  });

  it('edit_file refuse un dossier en lecture seule avec un message clair', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.archives, 'x.txt'), 'ancien');
      const out = await editFileTool.execute(
        { path: 'Archives/x.txt', old_str: 'ancien', new_str: 'neuf' },
        ctx(p),
      );
      expect(out.ok).toBe(false);
      expect(out.content).toContain('lecture seule');
      expect(await readFile(path.join(p.archives, 'x.txt'), 'utf8')).toBe('ancien');
    });
  });

  it('list_dir rappelle les autres dossiers à la racine du principal', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.primary, 'a.md'), 'a');
      await writeFile(path.join(p.archives, 'vieux.txt'), 'v');
      const root = await listDirTool.execute({}, ctx(p));
      expect(root.content).toContain('a.md');
      expect(root.content).toContain('Autres dossiers du projet');
      expect(root.content).toContain(`- Compta/ (lecture et écriture) : ${p.compta}`);
      expect(root.content).toContain('- Archives/ (lecture seule)');
      const archives = await listDirTool.execute({ path: 'Archives' }, ctx(p));
      expect(archives.content).toContain('vieux.txt');
      expect(archives.content).not.toContain('Autres dossiers du projet');
    });
  });

  it('list_dir signale un sous-dossier du principal qui masque un dossier rattaché', async () => {
    await withProject(async (p) => {
      await mkdir(path.join(p.primary, 'Compta'));
      await mkdir(path.join(p.primary, 'Ete-2026'));
      const context = ctx(p, {
        folders: [
          ...p.folders,
          { path: path.join(p.root, 'Ete'), label: 'Été 2026', access: 'read' },
        ],
      });
      const root = await listDirTool.execute({}, context);
      const line = (label: string): string =>
        root.content.split('\n').find((l) => l.startsWith(`- ${label}/`)) ?? '';
      expect(line('Compta')).toContain('masque « Compta/… »');
      // Forme dans la VM (« Ete-2026 ») : même collision que le libellé.
      expect(line('Été 2026')).toContain('masque « Été 2026/… »');
      expect(line('Archives')).not.toContain('masque');
    });
  });

  it('glob et present_file fonctionnent dans un dossier rattaché', async () => {
    await withProject(async (p) => {
      await mkdir(path.join(p.compta, '2026'));
      await writeFile(path.join(p.compta, '2026/bilan.csv'), 'x');
      const found = await globTool.execute({ pattern: '*.csv', path: 'Compta' }, ctx(p));
      expect(found.content).toBe('Compta/2026/bilan.csv');
      const shown = await presentFileTool.execute({ path: 'Compta/2026/bilan.csv' }, ctx(p));
      expect(shown.display).toMatchObject({
        type: 'file',
        file: { path: 'Compta/2026/bilan.csv', action: 'presented' },
      });
    });
  });
});

const project: PromptProject = {
  name: 'Ventes 2026',
  folders: [
    { path: '/u/Compta', label: 'Compta', access: 'write', guestPath: '/dossiers/Compta' },
    { path: '/u/Archives', label: 'Archives', access: 'read' },
  ],
  instructions: 'Réponds toujours avec un tableau.',
  memory: '## Notes\n\n- 30/10/2026 : le client préfère les PDF.',
  artifacts: [{ title: 'Tableau des ventes', path: 'Artefacts/ventes.html', version: 3 }],
};

describe('prompt système d’un projet', () => {
  const base = {
    workspace: '/u/Projet',
    now: new Date('2026-10-31T09:00:00Z'),
    timeZone: 'Europe/Paris',
    sandboxAvailable: true,
  };

  it('présente le projet, le dossier principal et les autres dossiers avec leur accès', () => {
    const prompt = buildSystemPrompt({ ...base, project, toolNames: ['bash'] });
    expect(prompt).toContain('Projet : « Ventes 2026 »');
    expect(prompt).toContain('Dossier principal : /u/Projet');
    expect(prompt).toContain('- Compta : /u/Compta (lecture et écriture)');
    expect(prompt).toContain('- Archives : /u/Archives (lecture seule');
    expect(prompt).toContain(
      'Compta : /dossiers/Compta ; Archives : /dossiers/Archives, lecture seule',
    );
  });

  it('sans projet, garde la section d’un seul dossier', () => {
    const prompt = buildSystemPrompt({ ...base, toolNames: [] });
    expect(prompt).toContain('Dossier de travail : /u/Projet');
    expect(prompt).not.toContain('# Mémoire du projet');
    expect(prompt).not.toContain('# Consignes du projet');
  });

  it('mémoire présentée comme des notes, entre deux marqueurs ; consignes à part', () => {
    const prompt = buildSystemPrompt({ ...base, project, toolNames: [] });
    expect(prompt).toContain('# Mémoire du projet');
    expect(prompt).toContain('pas des consignes');
    expect(prompt).toMatch(
      /--- début de la mémoire ---\n## Notes\n\n- 30\/10\/2026 : le client préfère les PDF\.\n--- fin de la mémoire ---/,
    );
    expect(prompt).toContain('# Consignes du projet');
    expect(prompt).toContain('Réponds toujours avec un tableau.');
    // Sans l'outil, pas de consigne d'écriture.
    expect(prompt).not.toContain('memory_add');
    expect(prompt.indexOf('# Consignes du projet')).toBeLessThan(prompt.indexOf('# Sécurité'));
  });

  it('dit quand retenir quelque chose si memory_add est disponible, et tronque une longue mémoire', () => {
    const long = {
      ...project,
      memory: `${'x'.repeat(MEMORY_PROMPT_CHARS - 10)}\n${'y'.repeat(500)}`,
    };
    const prompt = buildSystemPrompt({ ...base, project: long, toolNames: ['memory_add'] });
    expect(prompt).toContain('Utilise memory_add seulement');
    expect(prompt).toContain('Mémoire tronquée');
    // Coupée en fin de ligne : aucun morceau de la ligne suivante.
    expect(prompt).toContain(`${'x'.repeat(MEMORY_PROMPT_CHARS - 10)}\n--- fin de la mémoire ---`);
    expect(prompt).not.toContain('yyy');
    const empty = buildSystemPrompt({
      ...base,
      project: { ...project, memory: '' },
      toolNames: [],
    });
    expect(empty).toContain('La mémoire est vide');
  });

  it('section Artefacts avec la bibliothèque locale et les artefacts existants', () => {
    const prompt = buildSystemPrompt({ ...base, project, toolNames: ['publish_artifact'] });
    expect(prompt).toContain('# Artefacts');
    expect(prompt).toContain(ARTIFACT_CHART_LIB);
    expect(prompt).toContain('aucune ressource externe');
    expect(prompt).toContain('« Tableau des ventes » : Artefacts/ventes.html (version 3)');
    expect(buildSystemPrompt({ ...base, project, toolNames: [] })).not.toContain('# Artefacts');
  });
});

describe('appendMemoryNote', () => {
  const at = new Date(2026, 9, 31, 10, 0);

  it('crée la section Notes dans une mémoire vide', () => {
    expect(appendMemoryNote('', 'Le client préfère les PDF.', at)).toBe(
      `${MEMORY_NOTES_HEADING}\n\n- 31/10/2026 : Le client préfère les PDF.\n`,
    );
  });

  it('ajoute la section à la fin si elle manque', () => {
    expect(appendMemoryNote('# Projet\n\nContexte.\n', 'note', at)).toBe(
      '# Projet\n\nContexte.\n\n## Notes\n\n- 31/10/2026 : note\n',
    );
  });

  it('range la note à la fin de la section Notes, avant la section suivante', () => {
    const memory = '## Notes\n\n- 30/10/2026 : a\n\n## Échéances\n\n- 15/11 : bilan\n';
    expect(appendMemoryNote(memory, 'b', at)).toBe(
      '## Notes\n\n- 30/10/2026 : a\n- 31/10/2026 : b\n\n## Échéances\n\n- 15/11 : bilan\n',
    );
  });

  it('ramène une note sur plusieurs lignes à une seule', () => {
    expect(appendMemoryNote('## Notes\n', 'ligne 1\n  ligne 2', at)).toBe(
      '## Notes\n\n- 31/10/2026 : ligne 1 ligne 2\n',
    );
  });
});

describe('externalResources', () => {
  it('repère scripts, styles, images et polices externes, pas les liens', () => {
    const html = `<script src="https://cdn.example.com/chart.js"></script>
      <link rel="stylesheet" href="//fonts.example.com/a.css">
      <img src='http://img.example.com/x.png'>
      <style>@import "https://x.example.com/b.css"; body { background: url(https://y.example.com/c.png); }</style>
      <a href="https://example.com/doc">doc</a>
      <script src="${ARTIFACT_CHART_LIB}"></script>
      <img src="data:image/png;base64,AAAA">`;
    expect(externalResources(html).sort()).toEqual([
      '//fonts.example.com/a.css',
      'http://img.example.com/x.png',
      'https://cdn.example.com/chart.js',
      'https://x.example.com/b.css',
      'https://y.example.com/c.png',
    ]);
    expect(externalResources('<p>rien</p>')).toEqual([]);
  });
});

function runtimeFor(
  p: Fixture,
  handler = permissions(),
): ToolRuntime & {
  requestPermission: ReturnType<typeof permissions>;
} {
  return {
    sessionId: 's',
    workspace: p.primary,
    folders: p.folders,
    abortSignal: new AbortController().signal,
    requestPermission: handler,
  };
}

/** Mémoire factice : espions séparés de l'objet (règle unbound-method). */
function memoryWriter(): {
  writer: ProjectMemoryWriter;
  append: ReturnType<typeof vi.fn<ProjectMemoryWriter['append']>>;
  rewrite: ReturnType<typeof vi.fn<ProjectMemoryWriter['rewrite']>>;
} {
  const append = vi.fn<ProjectMemoryWriter['append']>((_s, note) =>
    Promise.resolve({ content: note, revision: 1 }),
  );
  const rewrite = vi.fn<ProjectMemoryWriter['rewrite']>((_s, content) =>
    Promise.resolve({ content, revision: 2 }),
  );
  return { writer: { append, rewrite }, append, rewrite };
}

/** Outil d'une liste, par son nom. */
function toolNamed(tools: readonly AnyToolDefinition[], name: string): AnyToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`Outil absent : ${name}`);
  return found;
}

describe('outils de mémoire', () => {
  it('memory_add demande une permission memory_write puis écrit la note', async () => {
    await withProject(async (p) => {
      const { writer, append } = memoryWriter();
      const add = toolNamed(createMemoryTools(writer), 'memory_add');
      const runtime = runtimeFor(p);
      const out = await executeTool(add, { note: '  Le client préfère les PDF. ' }, 'c1', runtime);
      expect(out).toMatchObject({ ok: true });
      expect(append).toHaveBeenCalledWith('s', 'Le client préfère les PDF.');
      const [request] = runtime.requestPermission.requests;
      expect(request).toMatchObject({
        kind: 'memory_write',
        scopeKey: 'memory_add',
        title: 'Retenir dans la mémoire du projet : « Le client préfère les PDF. »',
      });
    });
  });

  it('un refus n’écrit rien ; une erreur de l’app revient au modèle', async () => {
    await withProject(async (p) => {
      const { writer, append, rewrite: rewriteSpy } = memoryWriter();
      const tools = createMemoryTools(writer);
      const add = toolNamed(tools, 'memory_add');
      const rewrite = toolNamed(tools, 'memory_rewrite');
      const denied = await executeTool(
        add,
        { note: 'x' },
        'c1',
        runtimeFor(p, permissions('deny')),
      );
      expect(denied).toMatchObject({ ok: false, denied: true });
      expect(append).not.toHaveBeenCalled();

      rewriteSpy.mockRejectedValueOnce(
        new AtelierError('project/not_found', 'Cette conversation n’appartient à aucun projet.'),
      );
      const failed = await executeTool(rewrite, { content: '# Mémoire' }, 'c2', runtimeFor(p));
      expect(failed).toEqual({
        ok: false,
        content: 'Cette conversation n’appartient à aucun projet.',
      });
    });
  });

  it('memory_rewrite refuse une mémoire vide', async () => {
    await withProject(async (p) => {
      const { writer, rewrite: rewriteSpy } = memoryWriter();
      const rewrite = toolNamed(createMemoryTools(writer), 'memory_rewrite');
      const out = await executeTool(rewrite, { content: '   ' }, 'c', runtimeFor(p));
      expect(out.ok).toBe(false);
      expect(out.content).toContain('Mémoire vide refusée');
      expect(rewriteSpy).not.toHaveBeenCalled();
    });
  });

  it('memory_rewrite décrit une réécriture complète', async () => {
    await withProject(async (p) => {
      const rewrite = toolNamed(createMemoryTools(memoryWriter().writer), 'memory_rewrite');
      const runtime = runtimeFor(p);
      await executeTool(rewrite, { content: '## Notes\n\n- a' }, 'c', runtime);
      expect(runtime.requestPermission.requests[0]).toMatchObject({
        kind: 'memory_write',
        scopeKey: 'memory_rewrite',
        title: 'Réécrire la mémoire du projet',
      });
    });
  });
});

/** Publication factice : renvoie une carte en version 2. */
function publisher(): {
  pub: ArtifactPublisher;
  publish: ReturnType<typeof vi.fn<ArtifactPublisher['publish']>>;
} {
  const publish = vi.fn<ArtifactPublisher['publish']>((request: ArtifactPublishRequest) => {
    const card: ArtifactCard = {
      id: 'a1',
      title: request.title,
      version: 2,
      format: request.format,
      path: request.path,
    };
    return Promise.resolve(card);
  });
  return { pub: { publish }, publish };
}

describe('publish_artifact', () => {
  it('publie une page du dossier principal, sans permission, avec une carte', async () => {
    await withProject(async (p) => {
      await mkdir(path.join(p.primary, 'Artefacts'));
      await writeFile(path.join(p.primary, 'Artefacts/ventes.html'), '<h1>Ventes</h1>');
      const { pub, publish } = publisher();
      const runtime = runtimeFor(p);
      const out = await executeTool(
        createPublishArtifactTool(pub),
        { path: 'Artefacts/ventes.html', title: ' Tableau des ventes ', description: 'Suivi' },
        'c',
        runtime,
      );
      expect(out.ok).toBe(true);
      expect(out.content).toContain('« Tableau des ventes » (version 2)');
      expect(out.display).toEqual({
        type: 'artifact',
        artifact: {
          id: 'a1',
          title: 'Tableau des ventes',
          version: 2,
          format: 'html',
          path: path.join(p.primary, 'Artefacts/ventes.html'),
        },
      });
      expect(runtime.requestPermission.requests).toEqual([]);
      const request = publish.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        sessionId: 's',
        path: path.join(p.primary, 'Artefacts/ventes.html'),
        displayPath: 'Artefacts/ventes.html',
        title: 'Tableau des ventes',
        description: 'Suivi',
        format: 'html',
      });
      expect(Buffer.from(request?.content ?? new Uint8Array()).toString('utf8')).toBe(
        '<h1>Ventes</h1>',
      );
    });
  });

  it('publie un compte rendu Markdown d’un dossier en lecture seule', async () => {
    await withProject(async (p) => {
      await writeFile(path.join(p.archives, 'bilan.md'), '# Bilan');
      const { pub, publish } = publisher();
      const out = await createPublishArtifactTool(pub).execute(
        { path: 'Archives/bilan.md', title: 'Bilan' },
        ctx(p),
      );
      expect(out.ok).toBe(true);
      expect(publish.mock.calls[0]?.[0]).toMatchObject({
        format: 'markdown',
        displayPath: 'Archives/bilan.md',
      });
    });
  });

  it('refuse un fichier absent, un autre format ou une page trop lourde', async () => {
    await withProject(async (p) => {
      const { pub, publish } = publisher();
      const tool = createPublishArtifactTool(pub);
      const missing = await tool.execute({ path: 'absent.html', title: 'T' }, ctx(p));
      expect(missing.content).toContain('Fichier introuvable');
      await writeFile(path.join(p.primary, 'data.csv'), 'a;b');
      const csv = await tool.execute({ path: 'data.csv', title: 'T' }, ctx(p));
      expect(csv.content).toContain('.html, .htm et .md');
      await writeFile(path.join(p.primary, 'gros.html'), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
      const big = await tool.execute({ path: 'gros.html', title: 'T' }, ctx(p));
      expect(big.ok).toBe(false);
      expect(big.content).toContain('limité à 5,0 Mo');
      const outside = await tool.execute({ path: path.join(p.root, 'x.html'), title: 'T' }, ctx(p));
      expect(outside.ok).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it('signale les ressources externes qui seront bloquées', async () => {
    await withProject(async (p) => {
      await writeFile(
        path.join(p.primary, 'page.html'),
        '<script src="https://cdn.example.com/chart.js"></script>',
      );
      const out = await createPublishArtifactTool(publisher().pub).execute(
        { path: 'page.html', title: 'Page' },
        ctx(p),
      );
      expect(out.ok).toBe(true);
      expect(out.content).toContain('ressources externes');
      expect(out.content).toContain('https://cdn.example.com/chart.js');
    });
  });
});

describe('runs planifiés et mémoire', () => {
  const policy: ScheduledPermissions = {
    fileWrite: true,
    commands: false,
    webDomains: [],
    mcpTools: [],
  };
  const request: PermissionRequest = {
    id: 'r',
    sessionId: 's',
    toolCallId: 'c',
    toolName: 'memory_add',
    kind: 'memory_write',
    title: 'Retenir…',
    scopeKey: 'memory_add',
    input: {},
  };

  it('memory_write n’est accordé qu’avec la case mémoire, « fichiers » ne la couvre pas', async () => {
    const denied: DeniedAction[] = [];
    expect(await unattendedPermissionHandler(policy, (d) => denied.push(d))(request)).toBe('deny');
    expect(denied).toEqual([
      { toolName: 'memory_add', kind: 'memory_write', scopeKey: 'memory_add', title: 'Retenir…' },
    ]);
    expect(
      await unattendedPermissionHandler({ ...policy, memory: true }, () => undefined)(request),
    ).toBe('allow_once');
  });
});

describe('session de projet (createAgentRuntime)', () => {
  it('relit le projet à chaque tour : dossiers des outils, prompt et outils de session', async () => {
    await withProject(async (p) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'write_file', input: { path: 'Compta/note.md', content: 'ok' } }] },
        { text: 'Écrit dans Compta.' },
      ]);
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ parameters: 'num_ctx 32768' }))),
      );
      const runtime = await createAgentRuntime({
        llm: { baseUrl: 'https://llm.example.com', model: 'm', fetch },
        models: { model, fastModel: scriptedModel([]) },
      });
      const { writer } = memoryWriter();
      let reads = 0;
      const session = runtime.createSession({
        sessionId: 's',
        workspace: p.primary,
        requestPermission: permissions(),
        tools: createMemoryTools(writer),
        project: () => {
          reads += 1;
          return Promise.resolve({
            name: 'Ventes',
            folders: p.folders,
            memory: '- note du projet',
          });
        },
      });
      const { emit } = collect();
      const result = await session.send('Écris la note dans Compta.', emit);
      expect(result.reason).toBe('stop');
      expect(reads).toBe(1);
      expect(await readFile(path.join(p.compta, 'note.md'), 'utf8')).toBe('ok');
      const sent = promptText(model, 0);
      expect(sent).toContain('Projet : « Ventes »');
      expect(sent).toContain('- note du projet');
      expect(sent).toContain('Utilise memory_add seulement');
      // Un projet illisible n'empêche pas le tour : seul le dossier principal reste accessible.
      const broken = runtime.createSession({
        sessionId: 's2',
        workspace: p.primary,
        requestPermission: permissions(),
        project: () => Promise.reject(new Error('base indisponible')),
      });
      await expect(broken.agent.currentProject()).resolves.toBeUndefined();
    });
  });

  it('lecture du projet en échec : le dernier projet lu garde les dossiers rattachés', async () => {
    await withProject(async (p) => {
      const model = scriptedModel([
        { text: 'Premier tour.' },
        { toolCalls: [{ name: 'write_file', input: { path: 'Compta/y.md', content: 'ok' } }] },
        { text: 'Écrit.' },
      ]);
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ parameters: 'num_ctx 32768' }))),
      );
      const runtime = await createAgentRuntime({
        llm: { baseUrl: 'https://llm.example.com', model: 'm', fetch },
        models: { model, fastModel: scriptedModel([]) },
      });
      let calls = 0;
      const session = runtime.createSession({
        sessionId: 's',
        workspace: p.primary,
        requestPermission: permissions(),
        project: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve({ name: 'Ventes', folders: p.folders })
            : Promise.reject(new Error('base occupée'));
        },
      });
      const { emit } = collect();
      await session.send('Bonjour', emit);
      await session.send('Écris dans Compta.', emit);
      expect(await readFile(path.join(p.compta, 'y.md'), 'utf8')).toBe('ok');
      await expect(readFile(path.join(p.primary, 'Compta', 'y.md'))).rejects.toThrow();
      expect(promptText(model, 1)).toContain('Projet : « Ventes »');
    });
  });
});
