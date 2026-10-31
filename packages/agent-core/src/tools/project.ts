/**
 * Outils des projets (ADR-003) : mémoire du projet (`memory_add`,
 * `memory_rewrite`) et publication d'artefacts (`publish_artifact`).
 *
 * Le stockage est injecté par l'app (SQLite côté main) : ces outils ne font que
 * valider, lire le fichier à publier (garde des dossiers comprise) et décrire
 * les demandes de permission.
 */
import { open } from 'node:fs/promises';
import { z } from 'zod';
import {
  AtelierError,
  artifactFormatOf,
  defineTool,
  MAX_ARTIFACT_BYTES,
  MAX_MEMORY_CHARS,
  type AnyToolDefinition,
  type ArtifactCard,
  type ArtifactFormat,
  type ToolOutput,
} from '@atelier/shared';
import { resolveFolderPath } from '../paths.js';
import { guarded } from './native.js';
import { preview } from './permission.js';

/** Note de mémoire : une phrase, pas un document. */
export const MAX_MEMORY_NOTE_CHARS = 500;
/** Titre d'un artefact (2 à 5 mots en pratique). */
export const MAX_ARTIFACT_TITLE_CHARS = 80;
export const MAX_ARTIFACT_DESCRIPTION_CHARS = 300;
/** Titre de la section où `memory_add` range les notes. */
export const MEMORY_NOTES_HEADING = '## Notes';

/** Mémoire du projet de la conversation (main : `MemoryStore`, révision tracée). */
export interface ProjectMemoryWriter {
  /**
   * Ajoute une note datée (voir {@link appendMemoryNote}) et renvoie la mémoire
   * mise à jour. Rejette une `AtelierError` si la conversation n'a pas de projet.
   */
  append(sessionId: string, note: string): Promise<{ content: string; revision: number }>;
  /** Remplace toute la mémoire et renvoie la mémoire mise à jour. */
  rewrite(sessionId: string, content: string): Promise<{ content: string; revision: number }>;
}

/** Demande de publication transmise à l'app (`ArtifactStore`). */
export interface ArtifactPublishRequest {
  sessionId: string;
  /** Chemin absolu canonique du fichier publié : l'identité de l'artefact dans le projet. */
  path: string;
  /** Chemin affiché (relatif au principal, ou « <dossier>/… »). */
  displayPath: string;
  title: string;
  description?: string;
  format: ArtifactFormat;
  /** Contenu photographié pour cette version. */
  content: Uint8Array;
}

/** Publication des artefacts (main : nouvelle version si le chemin est déjà publié). */
export interface ArtifactPublisher {
  publish(request: ArtifactPublishRequest): Promise<ArtifactCard>;
}

/** Date courte des notes de mémoire (« 31/10/2026 »). */
function noteDate(at: Date): string {
  return at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Ajoute une note datée sous la section « ## Notes » de la mémoire (créée à la
 * fin si absente). Une note sur plusieurs lignes est ramenée à une seule.
 * Fonction pure : le main l'applique au moment d'écrire, sur la dernière révision.
 */
export function appendMemoryNote(memory: string, note: string, at: Date): string {
  const line = `- ${noteDate(at)} : ${note.replace(/\s+/g, ' ').trim()}`;
  const text = memory.replace(/\s+$/, '');
  if (text === '') return `${MEMORY_NOTES_HEADING}\n\n${line}\n`;
  const lines = text.split('\n');
  const heading = lines.findIndex((l) => l.trim() === MEMORY_NOTES_HEADING);
  if (heading === -1) return `${text}\n\n${MEMORY_NOTES_HEADING}\n\n${line}\n`;
  // Fin de la section : prochain titre de même niveau ou supérieur, sinon fin du texte.
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  // Dernière ligne non vide de la section : la note se place juste après.
  let insertAt = end;
  while (insertAt > heading + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
  const before = lines.slice(0, insertAt);
  if (insertAt === heading + 1) before.push('');
  const after = lines.slice(insertAt);
  return `${[...before, line, ...after].join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * Ressources externes d'une page HTML (scripts, styles, images, polices…) :
 * elles seront bloquées dans la visionneuse (aucun réseau, ADR-003 D5). Les
 * liens `<a href>` ne sont pas comptés.
 */
export function externalResources(html: string): string[] {
  const found = new Set<string>();
  const tag =
    /<(?:script|img|link|iframe|source|video|audio|embed|object)\b[^>]*?\b(?:src|href|data)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi;
  const css = /(?:url\(\s*["']?|@import\s+["'])((?:https?:)?\/\/[^"')\s]+)/gi;
  for (const re of [tag, css]) {
    for (const match of html.matchAll(re)) {
      const url = match[1];
      if (url !== undefined) found.add(url);
    }
  }
  return [...found];
}

const memoryAddInput = z.object({
  note: z
    .string()
    .min(1)
    .max(MAX_MEMORY_NOTE_CHARS)
    .describe(
      'Information à retenir, en une phrase courte (ex. « Le client préfère les rapports en PDF »).',
    ),
});

const memoryRewriteInput = z.object({
  content: z
    .string()
    .max(MAX_MEMORY_CHARS)
    .describe('Nouvelle mémoire complète, en Markdown : tout ce qui reste utile, réorganisé.'),
});

/** Ramène une note à une ligne pour un titre de modale. */
function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Erreurs métier de l'app (projet absent, mémoire trop longue…) et du système
 * de fichiers : renvoyées au modèle (`ok: false`), jamais levées.
 */
function guardedProject(run: () => Promise<ToolOutput>): Promise<ToolOutput> {
  return guarded(async () => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AtelierError && !error.code.startsWith('tool/')) {
        return { ok: false, content: error.message };
      }
      throw error;
    }
  });
}

/** Outils de mémoire d'un projet : `memory_add` et `memory_rewrite` (permission `memory_write`). */
export function createMemoryTools(memory: ProjectMemoryWriter): AnyToolDefinition[] {
  const add = defineTool({
    name: 'memory_add',
    description:
      "Retient une information utile pour la suite du projet dans sa mémoire, relue au début de chaque conversation : décision, préférence, information durable (nom, échéance, convention), étape franchie d'un travail en plusieurs fois. Une phrase courte. Jamais de secret ni de contenu brut de document. L'utilisateur valide chaque ajout.",
    inputSchema: memoryAddInput,
    permission: 'always',
    source: 'native',
    describePermission: (input) => ({
      kind: 'memory_write',
      title: `Retenir dans la mémoire du projet : « ${shorten(input.note, 80)} »`,
      detail: input.note.trim(),
      scopeKey: 'memory_add',
    }),
    execute: (input, context) =>
      guardedProject(async () => {
        const note = input.note.replace(/\s+/g, ' ').trim();
        if (note === '') return { ok: false, content: 'Note vide : rien à retenir.' };
        await memory.append(context.sessionId, note);
        return { ok: true, content: `Retenu dans la mémoire du projet : « ${note} ».` };
      }),
  });
  const rewrite = defineTool({
    name: 'memory_rewrite',
    description:
      "Réécrit toute la mémoire du projet, pour la réorganiser ou retirer ce qui n'est plus vrai, seulement quand l'utilisateur le demande. Garde tout ce qui reste utile. L'utilisateur valide la nouvelle version.",
    inputSchema: memoryRewriteInput,
    permission: 'always',
    source: 'native',
    describePermission: (input) => ({
      kind: 'memory_write',
      title: 'Réécrire la mémoire du projet',
      detail: preview(input.content),
      scopeKey: 'memory_rewrite',
    }),
    execute: (input, context) =>
      guardedProject(async () => {
        if (input.content.trim() === '') {
          return {
            ok: false,
            content:
              "Mémoire vide refusée : pour tout effacer, l'utilisateur le fait lui-même depuis la page du projet.",
          };
        }
        const updated = await memory.rewrite(context.sessionId, input.content.trim());
        return {
          ok: true,
          content: `Mémoire du projet réécrite (${String(updated.content.length)} caractères).`,
        };
      }),
  });
  return [add, rewrite] as AnyToolDefinition[];
}

const publishInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Fichier à publier : page .html (ou compte rendu .md), ex. "Artefacts/tableau-ventes.html".',
    ),
  title: z
    .string()
    .min(1)
    .max(MAX_ARTIFACT_TITLE_CHARS)
    .describe('Titre court de la page (2 à 5 mots), ex. « Tableau des ventes ».'),
  description: z
    .string()
    .max(MAX_ARTIFACT_DESCRIPTION_CHARS)
    .optional()
    .describe('Une phrase qui dit ce que montre la page.'),
});

/** Formatage d'une taille pour le modèle. */
function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/**
 * `publish_artifact` : publie une page déjà écrite (HTML ou Markdown) d'un
 * dossier de la conversation. Republier le même fichier crée une nouvelle
 * version du même artefact. Aucune permission : la page a été écrite avec
 * permission, et publier ne modifie aucun fichier (ADR-003 D5).
 */
export function createPublishArtifactTool(publisher: ArtifactPublisher): AnyToolDefinition {
  return defineTool({
    name: 'publish_artifact',
    description:
      "Publie une page déjà écrite (.html autonome, ou .md) comme artefact : l'utilisateur l'ouvre dans l'app, avec ses versions. Republier le même fichier après l'avoir modifié crée une nouvelle version de la même page (tableau de bord, rapport récurrent).",
    inputSchema: publishInput,
    permission: 'never',
    source: 'native',
    execute: (input, context) =>
      guardedProject(async () => {
        const resolved = await resolveFolderPath(context, input.path);
        if (!resolved.exists) {
          return {
            ok: false,
            content: `Fichier introuvable : ${input.path}. Écris d'abord la page (write_file), puis publie-la.`,
          };
        }
        const format = artifactFormatOf(resolved.absolutePath);
        if (format === undefined) {
          return {
            ok: false,
            content: `${input.path} ne peut pas être publié : seuls les fichiers .html, .htm et .md sont des artefacts.`,
          };
        }
        // Un seul descripteur pour la vérification et la lecture : le fichier ne
        // peut pas être remplacé entre les deux.
        const handle = await open(resolved.absolutePath, 'r');
        let content: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile()) return { ok: false, content: `${input.path} n'est pas un fichier.` };
          const tooBig = (size: number): ToolOutput => ({
            ok: false,
            content: `${input.path} pèse ${megabytes(size)} : un artefact est limité à ${megabytes(MAX_ARTIFACT_BYTES)}. Allège la page (données résumées, images plus petites).`,
          });
          if (info.size > MAX_ARTIFACT_BYTES) return tooBig(info.size);
          content = await handle.readFile();
          if (content.byteLength > MAX_ARTIFACT_BYTES) return tooBig(content.byteLength);
        } finally {
          await handle.close();
        }
        const title = input.title.trim();
        const description = input.description?.trim();
        const card = await publisher.publish({
          sessionId: context.sessionId,
          path: resolved.absolutePath,
          displayPath: resolved.relativePath,
          title,
          ...(description ? { description } : {}),
          format,
          content,
        });
        const external =
          format === 'html' ? externalResources(content.toString('utf8')).slice(0, 5) : [];
        const warning =
          external.length > 0
            ? `\nAttention : la page charge des ressources externes qui seront bloquées dans l'app (aucun accès à internet) : ${external.join(', ')}. Intègre-les dans le fichier, puis republie-le.`
            : '';
        return {
          ok: true,
          content: `Artefact publié : « ${card.title} » (version ${String(card.version)}), depuis ${resolved.relativePath}. L'utilisateur l'ouvre depuis le chat. Pour le mettre à jour, modifie ce fichier puis republie-le.${warning}`,
          display: { type: 'artifact', artifact: card },
        };
      }),
  });
}
