/**
 * Outil `bash` : délègue à l'interface {@link Sandbox} de shared (VM Lima).
 * Permission demandée sauf pour les commandes de la liste blanche (lecture seule).
 */
import { z } from 'zod';
import { defineTool, isAllowed, type SandboxExecResult } from '@atelier/shared';
import { askPermission, defaultDescribePermission, deniedOutput } from './permission.js';
import { DEFAULT_MAX_OUTPUT_BYTES, truncateOutput } from './text.js';

/** Délai par défaut d'une commande (brief §2). */
export const BASH_TIMEOUT_MS = 120_000;

/** Commandes en lecture seule exécutées sans confirmation. */
export const BASH_WHITELIST: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'wc',
  'pwd',
  'echo',
  'file',
  'stat',
  'du',
  'df',
  'sort',
  'uniq',
  'cut',
  'tr',
  'date',
  'which',
  'tree',
  'rg',
  'diff',
  'nl',
  'basename',
  'dirname',
  'whoami',
  'uname',
]);

/**
 * Vrai si la commande ne contient que des commandes de la liste blanche,
 * éventuellement chaînées par des pipes. Toute redirection, substitution,
 * séquence (`;`, `&&`, `&`) ou expansion refuse la liste blanche.
 */
export function isWhitelistedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === '') return false;
  // Métacaractères qui permettent d'écrire, d'enchaîner ou d'exécuter autre chose.
  if (/[;&<>`$(){}\n\\]|\|\|/.test(trimmed)) return false;
  return trimmed.split('|').every((segment) => {
    const words = segment.trim().split(/\s+/);
    const program = words[0];
    if (program === undefined || !BASH_WHITELIST.has(program)) return false;
    // Options d'écriture connues de commandes par ailleurs inoffensives.
    if (words.some((w) => w === '-o' || w.startsWith('--output'))) return false;
    // Lecture hors du dossier de travail ou des skills : on demande toujours.
    return !words.slice(1).some(leavesWorkspace);
  });
}

/** Vrai si un argument désigne un chemin hors de `/workspace` et `/skills`. */
function leavesWorkspace(word: string): boolean {
  const arg = word.replace(/^['"]|['"]$/g, '').replace(/^-[^=]*=/, '');
  if (arg.startsWith('~')) return true;
  if (arg.split('/').includes('..')) return true;
  if (arg.startsWith('/')) {
    return !/^\/(workspace|skills)(\/|$)/.test(arg);
  }
  return false;
}

function formatResult(result: SandboxExecResult): string {
  const parts: string[] = [];
  if (result.stdout !== '') parts.push(result.stdout.trimEnd());
  if (result.stderr !== '') parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.timedOut)
    parts.push(`[commande interrompue : délai de ${BASH_TIMEOUT_MS / 1000} s dépassé]`);
  parts.push(`[code de sortie : ${result.exitCode ?? 'tuée'}]`);
  return truncateOutput(parts.join('\n'), DEFAULT_MAX_OUTPUT_BYTES + 512).text;
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    "Exécute une commande shell dans la machine virtuelle Linux isolée (Ubuntu). Le dossier de travail y est monté sur /workspace (répertoire courant). Utile pour convertir des fichiers, calculer, lancer Python, etc. Délai max 120 s, sortie tronquée à 10 ko. Pas d'accès réseau par défaut.",
  inputSchema: z.object({
    command: z.string().min(1).describe('Ligne de commande bash.'),
  }),
  permission: 'conditional',
  source: 'native',
  async execute(input, context) {
    if (!context.sandbox) {
      return {
        ok: false,
        content:
          "La machine virtuelle n'est pas disponible pour le moment : impossible d'exécuter des commandes. Utilise les outils fichiers à la place.",
      };
    }
    if (!isWhitelistedCommand(input.command)) {
      const description = defaultDescribePermission('bash', input);
      const decision = await askPermission(context, 'bash', input, description);
      if (!isAllowed(decision)) return deniedOutput(description.title);
    }
    const result = await context.sandbox.exec(input.command, {
      timeoutMs: BASH_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      signal: context.abortSignal,
    });
    const output = formatResult(result);
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: output,
      display: {
        type: 'command',
        command: input.command,
        exitCode: result.exitCode ?? -1,
        output,
      },
    };
  },
});
