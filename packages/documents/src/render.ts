/**
 * Rendu d'une page PDF en PNG avec `pdftoppm` (poppler-utils), exécuté DANS la
 * VM : un PDF piégé n'attaque que la sandbox, jamais l'hôte. L'image est écrite
 * dans `<dossier>/.atelier/cache/pages/` (visible des deux côtés via
 * `/workspace`), relue côté hôte après vérification du chemin.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { GUEST_WORKSPACE, AtelierError, type Sandbox } from '@atelier/shared';
import { resolveWorkspacePath } from '@atelier/agent-core';
import { CACHE_DIR } from './cache.js';
import { readRegularFile } from './fs.js';
import { MAX_IMAGE_SIDE } from './image.js';

/** Dossier des rendus, relatif au dossier de travail. */
export const PAGES_DIR = `${CACHE_DIR}/pages`;
/** Délai maximal de rendu d'une page. */
export const RENDER_TIMEOUT_MS = 60_000;

/** Demande de rendu. */
export interface RenderPageRequest {
  sandbox: Sandbox;
  /** Dossier de travail (hôte). */
  workspace: string;
  /** Chemin du PDF relatif au dossier de travail. */
  relativePath: string;
  /** Empreinte du fichier (nom du rendu). */
  fileHash: string;
  /** Page (1-based). */
  page: number;
  signal?: AbortSignal;
}

/** Échappement pour `bash -lc` (guillemets simples). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Chemin VM d'un chemin relatif au dossier de travail. */
export function guestPathOf(sandbox: Sandbox, workspace: string, relativePath: string): string {
  const mapped = sandbox.toGuestPath(path.join(workspace, relativePath));
  if (mapped) return mapped;
  // La VM monte le dossier de travail sur /workspace : chemin relatif identique.
  return relativePath === '.' ? GUEST_WORKSPACE : `${GUEST_WORKSPACE}/${relativePath}`;
}

/**
 * Rend une page en PNG (grand côté 1568 px) et renvoie l'image.
 * @throws AtelierError `sandbox/*` si la VM n'est pas prête, `tool/failed` si
 *   `pdftoppm` échoue.
 */
export async function renderPdfPage(request: RenderPageRequest): Promise<Buffer> {
  const { sandbox, workspace, relativePath, fileHash, page } = request;
  const name = `${fileHash.slice(0, 32)}-p${page}`;
  const target = await resolveWorkspacePath(workspace, `${PAGES_DIR}/${name}.png`);
  await mkdir(path.dirname(target.absolutePath), { recursive: true });
  // Retire un rendu périmé (ou un lien posé à sa place) avant de lancer pdftoppm.
  await rm(target.absolutePath, { force: true });

  const pdf = guestPathOf(sandbox, workspace, relativePath);
  const prefix = guestPathOf(sandbox, workspace, `${PAGES_DIR}/${name}`);
  const command = [
    'pdftoppm',
    '-f',
    String(page),
    '-l',
    String(page),
    '-scale-to',
    String(MAX_IMAGE_SIDE),
    '-png',
    '-singlefile',
    shellQuote(pdf),
    shellQuote(prefix),
  ].join(' ');
  const result = await sandbox.exec(command, {
    timeoutMs: RENDER_TIMEOUT_MS,
    maxOutputBytes: 4_096,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (result.timedOut) {
    throw new AtelierError(
      'tool/failed',
      `Le rendu de la page ${page} a dépassé ${RENDER_TIMEOUT_MS / 1000} s.`,
    );
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const missing = result.exitCode === 127 || /command not found/i.test(stderr);
    throw new AtelierError(
      'tool/failed',
      missing
        ? 'pdftoppm est absent de la VM (paquet poppler-utils) : réinitialise la VM depuis les Réglages.'
        : `Échec du rendu de la page ${page} (code ${result.exitCode ?? 'tué'})${stderr ? ` : ${stderr.slice(0, 300)}` : ''}.`,
    );
  }
  // Relecture côté hôte : le chemin doit toujours être un fichier du dossier de travail.
  const output = await resolveWorkspacePath(workspace, `${PAGES_DIR}/${name}.png`);
  if (!output.exists) {
    throw new AtelierError(
      'tool/failed',
      `pdftoppm n'a produit aucune image pour la page ${page}.`,
    );
  }
  return readRegularFile(output.absolutePath, 50 * 1024 * 1024);
}
