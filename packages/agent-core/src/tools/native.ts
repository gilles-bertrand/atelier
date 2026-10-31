/**
 * Outils natifs exécutés côté hôte : write_file, edit_file, list_dir, glob, grep,
 * todo_write, present_file, et un read_file texte simple (M1, remplacé par
 * `packages/documents`).
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AtelierError,
  defineTool,
  folderGuestName,
  type AnyToolDefinition,
  type ToolExecutionContext,
  type ToolOutput,
  type ToolPrecheckContext,
  type ToolPrecheckFailure,
} from '@atelier/shared';
import { resolveFolderPath, type ReadRoot, type ResolvedFolderPath } from '../paths.js';
import { countOccurrences, truncateOutput } from './text.js';
import { preview } from './permission.js';
import { fileCard, globToRegExp, looksBinary, walkFiles } from './fs-utils.js';

/** Convertit les erreurs métier attendues en sortie `ok: false` lisible par le modèle. */
export async function guarded(run: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AtelierError && error.code.startsWith('tool/')) {
      return { ok: false, content: error.message };
    }
    if (isFsError(error)) {
      return { ok: false, content: fsErrorMessage(error) };
    }
    throw error;
  }
}

/**
 * Erreurs du système de fichiers qui condamnent l'appel : chemin absent, pas un
 * dossier, droits, boucle de liens… Les autres (`EMFILE`, `EBUSY`…) peuvent être
 * passagères : la vérification préalable les laisse à `execute`.
 */
const CERTAIN_FS_ERRORS: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EPERM',
  'ELOOP',
  'ENAMETOOLONG',
]);

/**
 * Vérification préalable (ADR-003, D9) faite des contrôles d'`execute`, avec les
 * mêmes messages que {@link guarded}. `check` renvoie un échec, ou `undefined`
 * si l'appel peut se faire. Seuls les refus certains deviennent un échec : une
 * erreur passagère ou inattendue est relancée, et `executeTool` pose alors la
 * question (la vérification ne conclut pas).
 */
export async function guardedPrecheck(
  check: () => Promise<ToolPrecheckFailure | undefined>,
): Promise<ToolPrecheckFailure | undefined> {
  try {
    const failure = await check();
    return failure ? { ok: false, content: failure.content } : undefined;
  } catch (error) {
    if (error instanceof AtelierError && error.code.startsWith('tool/')) {
      return { ok: false, content: error.message };
    }
    if (isFsError(error) && error.code !== undefined && CERTAIN_FS_ERRORS.has(error.code)) {
      return { ok: false, content: fsErrorMessage(error) };
    }
    throw error;
  }
}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function fsErrorMessage(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ENOENT':
      return 'Fichier ou dossier introuvable.';
    case 'EISDIR':
      return 'Ce chemin est un dossier, pas un fichier.';
    case 'ENOTDIR':
      return "Ce chemin n'est pas un dossier.";
    case 'EACCES':
    case 'EPERM':
      return 'Accès refusé par le système.';
    default:
      return `Erreur système (${error.code ?? 'inconnue'}) : ${error.message}`;
  }
}

const pathField = z
  .string()
  .min(1)
  .describe(
    'Chemin relatif au dossier de travail (ex. "rapport.md" ou "notes/2026.txt"), ou "<dossier>/…" pour un autre dossier du projet.',
  );

/** Options des outils natifs de lecture. */
export interface NativeToolsOptions {
  /**
   * Dossiers lisibles en lecture seule hors du dossier de travail (racine des
   * skills, #60), relus à chaque appel. Les outils d'écriture les ignorent.
   */
  readRoots?: () => readonly ReadRoot[];
}

const readPathField = z
  .string()
  .min(1)
  .describe(
    'Chemin relatif au dossier de travail (ex. "rapport.md"), "<dossier>/…" pour un autre dossier du projet, ou chemin d\'un SKILL.md tel qu\'indiqué dans la section Skills.',
  );

/** Lecture texte simple (M1). Remplacé par l'outil multi-format de `documents`. */
export function createReadFileTool(options: NativeToolsOptions = {}) {
  return defineTool({
    name: 'read_file',
    description:
      'Lit un fichier texte du dossier de travail et renvoie son contenu avec des numéros de ligne. Utilise offset/limit pour les gros fichiers.',
    inputSchema: z.object({
      path: readPathField,
      offset: z.number().int().min(1).optional().describe('Première ligne à lire (1 = début).'),
      limit: z.number().int().min(1).max(5_000).optional().describe('Nombre de lignes à lire.'),
    }),
    permission: 'never',
    source: 'native',
    execute: (input, context) =>
      guarded(async () => {
        const resolved = await resolveFolderPath(context, input.path, {
          readRoots: options.readRoots?.() ?? [],
        });
        if (!resolved.exists) return { ok: false, content: `Fichier introuvable : ${input.path}` };
        if (await looksBinary(resolved.absolutePath)) {
          return {
            ok: false,
            content: `${input.path} est un fichier binaire : la lecture de ce format n'est pas encore prise en charge.`,
          };
        }
        const text = await readFile(resolved.absolutePath, 'utf8');
        const lines = text.split('\n');
        const start = (input.offset ?? 1) - 1;
        const end = input.limit !== undefined ? start + input.limit : lines.length;
        const numbered = lines
          .slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
          .join('\n');
        const header =
          end < lines.length ? `[lignes ${start + 1}-${end} sur ${lines.length}]\n` : '';
        return { ok: true, content: truncateOutput(header + numbered).text };
      }),
  });
}

/** `read_file` natif sans racine de lecture supplémentaire. */
export const readFileTool = createReadFileTool();

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    "Crée un fichier ou remplace entièrement son contenu dans le dossier de travail. Les dossiers parents sont créés au besoin. Pour modifier une partie d'un fichier existant, préfère edit_file.",
  inputSchema: z.object({
    path: pathField,
    content: z.string().describe('Contenu complet du fichier.'),
  }),
  permission: 'always',
  source: 'native',
  describePermission: (input) => ({
    kind: 'file_write',
    title: `Écrire le fichier ${input.path}`,
    detail: preview(input.content),
    scopeKey: 'write_file',
  }),
  // Dossier en lecture seule ou chemin hors des dossiers : refus sans modale (D9).
  precheck: (input, context) =>
    guardedPrecheck(async () => {
      await resolveFolderPath(context, input.path, { write: true });
      return undefined;
    }),
  execute: (input, context) =>
    guarded(async () => {
      const resolved = await resolveFolderPath(context, input.path, { write: true });
      await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      // Re-vérifie après création des dossiers (course avec un symlink posé entre-temps).
      const final = await resolveFolderPath(context, input.path, { write: true });
      await writeFile(final.absolutePath, input.content, 'utf8');
      const size = Buffer.byteLength(input.content, 'utf8');
      const action = resolved.exists ? 'modified' : 'created';
      return {
        ok: true,
        content: `${action === 'created' ? 'Fichier créé' : 'Fichier remplacé'} : ${final.relativePath} (${size} octets).`,
        display: {
          type: 'file',
          file: fileCard(final.relativePath, final.absolutePath, size, action),
        },
      };
    }),
});

/** Remplacement prêt à écrire, ou la raison pour laquelle il ne peut pas l'être. */
type EditPlan =
  { ok: true; resolved: ResolvedFolderPath; before: string; index: number } | ToolPrecheckFailure;

/**
 * Contrôles d'`edit_file`, partagés par `precheck` et `execute` (ADR-003, D9) :
 * chemin dans un dossier en écriture, fichier présent, `old_str` présent une
 * seule fois. Les erreurs de chemin et du système de fichiers sont levées, pour
 * {@link guarded}.
 */
async function planEdit(
  context: ToolPrecheckContext,
  input: { path: string; old_str: string },
): Promise<EditPlan> {
  const resolved = await resolveFolderPath(context, input.path, { write: true });
  if (!resolved.exists) return { ok: false, content: `Fichier introuvable : ${input.path}` };
  const before = await readFile(resolved.absolutePath, 'utf8');
  const count = countOccurrences(before, input.old_str);
  if (count === 0) {
    return {
      ok: false,
      content: `Texte introuvable dans ${resolved.relativePath} : old_str doit correspondre exactement (espaces et retours à la ligne compris). Relis le fichier avec read_file.`,
    };
  }
  if (count > 1) {
    return {
      ok: false,
      content: `old_str apparaît ${count} fois dans ${resolved.relativePath} : ajoute des lignes de contexte pour qu'il soit unique.`,
    };
  }
  return { ok: true, resolved, before, index: before.indexOf(input.old_str) };
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Remplace dans un fichier un passage exact (old_str) par un nouveau texte (new_str). old_str doit apparaître une seule fois : inclus assez de contexte (lignes voisines) pour le rendre unique. Lis le fichier avant de le modifier.',
  inputSchema: z.object({
    path: pathField,
    old_str: z.string().min(1).describe('Texte exact à remplacer (unique dans le fichier).'),
    new_str: z.string().describe('Texte de remplacement.'),
  }),
  permission: 'always',
  source: 'native',
  describePermission: (input) => ({
    kind: 'file_write',
    title: `Modifier le fichier ${input.path}`,
    detail: preview(`- ${input.old_str}\n+ ${input.new_str}`),
    scopeKey: 'edit_file',
  }),
  // Fichier absent, passage absent ou ambigu, lecture seule : refus sans modale (D9).
  precheck: (input, context) =>
    guardedPrecheck(async () => {
      const plan = await planEdit(context, input);
      return plan.ok ? undefined : plan;
    }),
  execute: (input, context) =>
    guarded(async () => {
      // Contrôles refaits : le fichier a pu changer pendant que la modale était ouverte.
      const plan = await planEdit(context, input);
      if (!plan.ok) return plan;
      const { resolved, before, index } = plan;
      const after =
        before.slice(0, index) + input.new_str + before.slice(index + input.old_str.length);
      await writeFile(resolved.absolutePath, after, 'utf8');
      return {
        ok: true,
        content: `Fichier modifié : ${resolved.relativePath}.`,
        display: { type: 'diff', path: resolved.relativePath, before, after },
      };
    }),
});

export function createListDirTool(options: NativeToolsOptions = {}) {
  return defineTool({
    name: 'list_dir',
    description:
      'Liste le contenu d\'un dossier (fichiers et sous-dossiers, avec leur taille). Par défaut, la racine du dossier de travail ; "<dossier>" pour un autre dossier du projet.',
    inputSchema: z.object({
      path: z.string().optional().describe('Dossier à lister (défaut : ".").'),
      show_hidden: z.boolean().optional().describe('Inclure les fichiers cachés (défaut : non).'),
    }),
    permission: 'never',
    source: 'native',
    execute: (input, context) =>
      guarded(async () => {
        const resolved = await resolveFolderPath(context, input.path ?? '.', {
          readRoots: options.readRoots?.() ?? [],
        });
        const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
        const inPrimary = !resolved.readOnly && resolved.folder === undefined;
        const isRoot = inPrimary && resolved.relativePath === '.';
        const isAppDir = inPrimary && resolved.relativePath === APP_DIR;
        // Pièces jointes : seul contenu de `.atelier/` signalé (cache et rendus restent masqués).
        const attachmentLine =
          isRoot || isAppDir ? await attachmentsLine(context.workspace) : undefined;
        // À la racine du principal, rappel des autres dossiers du projet (ADR-003).
        const names = new Set(entries.map((e) => e.name.toLocaleLowerCase('fr')));
        const attachments =
          [attachmentLine, isRoot ? projectFoldersLines(context, names) : undefined]
            .filter((line): line is string => line !== undefined)
            .join('\n\n') || undefined;
        const visible = entries
          .filter((e) => input.show_hidden === true || !e.name.startsWith('.'))
          .filter((e) => !isAppDir || e.name === 'uploads')
          .sort((a, b) =>
            a.isDirectory() === b.isDirectory()
              ? a.name.localeCompare(b.name)
              : a.isDirectory()
                ? -1
                : 1,
          );
        if (visible.length === 0) {
          return { ok: true, content: attachments ?? `${resolved.relativePath} est vide.` };
        }
        const lines: string[] = [];
        for (const entry of visible.slice(0, 500)) {
          if (entry.isDirectory()) {
            lines.push(`${entry.name}/`);
          } else if (entry.isSymbolicLink()) {
            lines.push(`${entry.name} (lien)`);
          } else {
            const size = (await stat(path.join(resolved.absolutePath, entry.name))).size;
            lines.push(`${entry.name} (${formatSize(size)})`);
          }
        }
        if (visible.length > 500) lines.push(`… ${visible.length - 500} autres entrées`);
        if (attachments !== undefined) lines.push('', attachments);
        return { ok: true, content: lines.join('\n') };
      }),
  });
}

/** `list_dir` natif sans racine de lecture supplémentaire. */
export const listDirTool = createListDirTool();

/** Dossier de l'app dans le dossier de travail (cache, rendus, pièces jointes). */
const APP_DIR = '.atelier';
/** Pièces jointes déposées par l'utilisateur (copiées par `documents`). */
export const UPLOADS_DIR = `${APP_DIR}/uploads`;
/** Noms de pièces jointes cités au plus par list_dir. */
export const MAX_LISTED_ATTACHMENTS = 20;

/**
 * Ligne « Pièces jointes : … » si `.atelier/uploads/` contient des fichiers :
 * le dossier est caché, sans elle le modèle ne les retrouve pas (#59).
 */
async function attachmentsLine(workspace: string): Promise<string | undefined> {
  let names: string[];
  try {
    const entries = await readdir(path.join(workspace, UPLOADS_DIR), { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const shown = names.slice(0, MAX_LISTED_ATTACHMENTS).map((n) => `${UPLOADS_DIR}/${n}`);
  const more =
    names.length > MAX_LISTED_ATTACHMENTS
      ? `, … et ${String(names.length - MAX_LISTED_ATTACHMENTS)} autres`
      : '';
  return `Pièces jointes : ${shown.join(', ')}${more}`;
}

/**
 * Rappel des dossiers rattachés d'un projet (liste du principal). Un
 * sous-dossier du principal qui porte le même nom masque « <libellé>/… » :
 * il est signalé, avec le chemin complet à utiliser.
 */
function projectFoldersLines(
  context: ToolExecutionContext,
  primaryNames: ReadonlySet<string>,
): string | undefined {
  const folders = context.folders ?? [];
  if (folders.length === 0) return undefined;
  const lines = folders.map((f) => {
    const label = f.label.trim();
    const line = `- ${label}/ (${f.access === 'read' ? 'lecture seule' : 'lecture et écriture'}) : ${f.path}`;
    // Mêmes noms que la résolution « <dossier>/… » : le libellé et sa forme dans la VM.
    const shadowed = [label, folderGuestName(label)].some((name) =>
      primaryNames.has(name.toLocaleLowerCase('fr')),
    );
    return shadowed
      ? `${line} [attention : un sous-dossier du dossier principal porte ce nom et masque « ${label}/… » ; utilise le chemin complet]`
      : line;
  });
  return `Autres dossiers du projet (chemins « <dossier>/… ») :\n${lines.join('\n')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

const MAX_GLOB_RESULTS = 500;

export const globTool = defineTool({
  name: 'glob',
  description:
    'Trouve des fichiers par motif de nom, récursivement (ex. "*.pdf", "rapports/**/*.md", "*.{csv,xlsx}"). Cherche dans le dossier de travail ; path="<dossier>" pour un autre dossier du projet.',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Motif glob.'),
    path: z.string().optional().describe('Dossier de départ (défaut : ".").'),
  }),
  permission: 'never',
  source: 'native',
  execute: (input, context) =>
    guarded(async () => {
      const base = await resolveFolderPath(context, input.path ?? '.');
      const re = globToRegExp(input.pattern);
      const matches: string[] = [];
      for await (const entry of walkFiles(base.absolutePath, { signal: context.abortSignal })) {
        if (re.test(entry.relativePath)) {
          matches.push(joinRel(base.relativePath, entry.relativePath));
          if (matches.length >= MAX_GLOB_RESULTS) break;
        }
      }
      if (matches.length === 0) return { ok: true, content: 'Aucun fichier trouvé.' };
      const suffix = matches.length >= MAX_GLOB_RESULTS ? '\n[… résultats limités à 500]' : '';
      return { ok: true, content: matches.join('\n') + suffix };
    }),
});

function joinRel(base: string, rel: string): string {
  return base === '.' ? rel : `${base}/${rel}`;
}

const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Cherche un texte ou une expression régulière dans les fichiers texte du dossier de travail (path="<dossier>" pour un autre dossier du projet). Renvoie fichier:ligne: contenu.',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Expression régulière (syntaxe JavaScript).'),
    path: z.string().optional().describe('Dossier ou fichier où chercher (défaut : ".").'),
    include: z.string().optional().describe('Filtre glob sur les fichiers (ex. "*.md").'),
    case_insensitive: z.boolean().optional().describe('Ignorer la casse.'),
  }),
  permission: 'never',
  source: 'native',
  execute: (input, context) =>
    guarded(async () => {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.case_insensitive === true ? 'i' : '');
      } catch (error) {
        return {
          ok: false,
          content: `Expression régulière invalide : ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const base = await resolveFolderPath(context, input.path ?? '.');
      const include = input.include !== undefined ? globToRegExp(input.include) : undefined;
      const baseInfo = await stat(base.absolutePath);
      const singleFile = baseInfo.isFile();
      const files = singleFile
        ? [
            {
              absolutePath: base.absolutePath,
              relativePath: base.relativePath,
              size: baseInfo.size,
            },
          ]
        : walkFiles(base.absolutePath, { signal: context.abortSignal });
      const out: string[] = [];
      outer: for await (const file of files) {
        if (include && !include.test(file.relativePath)) continue;
        if (file.size > MAX_GREP_FILE_BYTES || (await looksBinary(file.absolutePath))) continue;
        const rel = singleFile ? base.relativePath : joinRel(base.relativePath, file.relativePath);
        const lines = (await readFile(file.absolutePath, 'utf8')).split('\n');
        for (const [i, line] of lines.entries()) {
          if (re.test(line)) {
            out.push(`${rel}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
            if (out.length >= MAX_GREP_MATCHES) break outer;
          }
        }
      }
      if (out.length === 0) return { ok: true, content: 'Aucune correspondance.' };
      const suffix = out.length >= MAX_GREP_MATCHES ? '\n[… limité à 200 correspondances]' : '';
      return { ok: true, content: truncateOutput(out.join('\n') + suffix).text };
    }),
});

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().min(1).describe('Identifiant stable de la tâche.'),
        title: z.string().min(1).describe('Intitulé court, compréhensible par un non-développeur.'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .max(50)
    .describe('Liste complète des tâches (remplace la précédente).'),
});

export const todoWriteTool = defineTool({
  name: 'todo_write',
  description:
    "Remplace la liste de tâches affichée à l'utilisateur. À utiliser pour toute demande en plusieurs étapes : crée la liste au début, passe une seule tâche à la fois en in_progress, marque-la completed dès qu'elle est finie.",
  inputSchema: todoSchema,
  permission: 'never',
  source: 'native',
  execute: (input) => {
    const done = input.todos.filter((t) => t.status === 'completed').length;
    return Promise.resolve({
      ok: true,
      content: `Liste de tâches mise à jour (${done}/${input.todos.length} terminées).`,
      display: { type: 'todos', todos: input.todos },
    });
  },
});

export const presentFileTool = defineTool({
  name: 'present_file',
  description:
    "Affiche un fichier du dossier de travail sous forme de carte cliquable dans le chat. À utiliser pour remettre un livrable (rapport, tableau, document) à l'utilisateur.",
  inputSchema: z.object({ path: pathField }),
  permission: 'never',
  source: 'native',
  execute: (input, context) =>
    guarded(async () => {
      const resolved = await resolveFolderPath(context, input.path);
      if (!resolved.exists) return { ok: false, content: `Fichier introuvable : ${input.path}` };
      const info = await stat(resolved.absolutePath);
      if (!info.isFile()) return { ok: false, content: `${input.path} n'est pas un fichier.` };
      const display = {
        type: 'file' as const,
        file: fileCard(resolved.relativePath, resolved.absolutePath, info.size, 'presented'),
      };
      context.emitDisplay?.(display);
      return { ok: true, content: `Fichier présenté : ${resolved.relativePath}.`, display };
    }),
});

/** Outils natifs fichiers + tâches (bash est fourni à part, il dépend d'une Sandbox). */
export function createNativeTools(options: NativeToolsOptions = {}): AnyToolDefinition[] {
  return [
    createReadFileTool(options),
    writeFileTool,
    editFileTool,
    createListDirTool(options),
    globTool,
    grepTool,
    todoWriteTool,
    presentFileTool,
  ] as AnyToolDefinition[];
}
