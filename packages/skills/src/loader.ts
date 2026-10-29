/**
 * Découverte des skills : `<dossier>/<nom>/SKILL.md` avec un frontmatter YAML
 * (`name`, `description`). Seules les descriptions vont dans le prompt système ;
 * le modèle lit le SKILL.md complet via `read_file` quand c'est pertinent.
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import matter from 'gray-matter';
import { GUEST_SKILLS, type SkillInfo } from '@atelier/shared';

/** Nom du fichier décrivant un skill. */
export const SKILL_FILE = 'SKILL.md';
/** Dossier des scripts d'un skill. */
export const SCRIPTS_DIR = 'scripts';
/** Taille maximale d'un SKILL.md (au-delà, il est ignoré). */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Longueur maximale d'une description injectée dans le prompt. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Dossier des skills par défaut (brief §5). */
export function defaultSkillsDir(home: string = homedir()): string {
  return join(home, 'Atelier', 'skills');
}

/** Problème rencontré sur un skill (ignoré ou corrigé). */
export interface SkillWarning {
  /** Dossier du skill. */
  dir: string;
  /** Message lisible en français. */
  message: string;
}

/** Options de {@link loadSkills}. */
export interface LoadSkillsOptions {
  /** Racine des skills dans la VM (défaut : `/skills`) ; `null` pour ne pas la renseigner. */
  guestRoot?: string | null;
  /** Reçoit les skills ignorés ou corrigés. */
  onWarning?: (warning: SkillWarning) => void;
}

/** Normalise un texte de frontmatter : une seule ligne, espaces compactés. */
function singleLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Liste de chaînes du frontmatter (liste YAML ou texte séparé par des virgules). */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => singleLine(item))
    .filter((item) => item !== '');
}

/** Parse le frontmatter d'un SKILL.md ; `undefined` si invalide. */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string; triggers: string[]; scripts: string[] } | undefined {
  let data: Record<string, unknown>;
  try {
    data = matter(content).data;
  } catch {
    return undefined;
  }
  return {
    name: singleLine(data['name']),
    description: singleLine(data['description']),
    // Déclencheurs en minuscules, dédoublonnés (chargement d'office du skill).
    triggers: [...new Set(stringList(data['triggers']).map((t) => t.toLowerCase()))],
    scripts: stringList(data['scripts']),
  };
}

/** Fichiers de `<skill>/scripts/` (non cachés), triés ; liste vide si absent. */
async function scriptFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dir, SCRIPTS_DIR), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => `${SCRIPTS_DIR}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Scanne `skillsDir/*\/SKILL.md` et renvoie les skills valides, triés par nom.
 * Un dossier absent donne une liste vide. Les skills invalides sont ignorés
 * (signalés via `onWarning`), jamais bloquants.
 */
export async function loadSkills(
  skillsDir: string = defaultSkillsDir(),
  options: LoadSkillsOptions = {},
): Promise<SkillInfo[]> {
  const warn = (dir: string, message: string): void => options.onWarning?.({ dir, message });
  const guestRoot = options.guestRoot === undefined ? GUEST_SKILLS : options.guestRoot;

  let root: string;
  let entries: string[];
  try {
    root = await realpath(skillsDir);
    entries = (await readdir(root)).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const dir = join(root, entry);
    const file = join(dir, SKILL_FILE);
    if (!(await isFile(file))) continue;

    // Un lien symbolique qui sort du dossier ne serait pas visible dans la VM.
    const resolved = await realpath(file);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || rel.startsWith(sep)) {
      warn(dir, 'ignoré : SKILL.md pointe hors du dossier des skills.');
      continue;
    }
    if ((await lstat(resolved)).size > MAX_SKILL_FILE_BYTES) {
      warn(dir, `ignoré : SKILL.md dépasse ${String(MAX_SKILL_FILE_BYTES / 1024)} Ko.`);
      continue;
    }

    const parsed = parseSkillFrontmatter(await readFile(resolved, 'utf8'));
    if (!parsed) {
      warn(dir, 'ignoré : frontmatter YAML invalide.');
      continue;
    }
    if (!parsed.description) {
      warn(dir, 'ignoré : `description` manquante dans le frontmatter.');
      continue;
    }
    let name = parsed.name;
    if (!name) {
      name = entry;
      warn(dir, `\`name\` manquant : nom du dossier utilisé (« ${entry} »).`);
    }
    if (seen.has(name)) {
      warn(dir, `ignoré : un autre skill s'appelle déjà « ${name} ».`);
      continue;
    }
    seen.add(name);

    let description = parsed.description;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
      warn(dir, 'description tronquée (trop longue pour le prompt système).');
    }
    // Scripts : champ `scripts` du frontmatter (relatifs au skill, sans sortie du
    // dossier), sinon le contenu de `scripts/`. Chemins VM quand ils existent.
    const declared = parsed.scripts.filter((p) => {
      const normalized = posix.normalize(p);
      return !normalized.startsWith('..') && !posix.isAbsolute(normalized);
    });
    const relScripts = declared.length > 0 ? declared : await scriptFiles(dir);
    const scripts = relScripts.map((p) =>
      guestRoot === null ? join(dir, ...p.split('/')) : posix.join(guestRoot, entry, p),
    );
    skills.push({
      name,
      description,
      path: file,
      ...(guestRoot === null ? {} : { guestPath: posix.join(guestRoot, entry, SKILL_FILE) }),
      ...(scripts.length > 0 ? { scripts } : {}),
      ...(parsed.triggers.length > 0 ? { triggers: parsed.triggers } : {}),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Section du prompt système listant les skills (nom + description + chemins).
 * Chaîne vide s'il n'y a aucun skill.
 */
export function skillsPrompt(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return '';
  const lines = [
    '## Skills',
    '',
    "Les skills sont des guides prêts à l'emploi (instructions, modèles, scripts). " +
      "Quand une demande correspond à la description d'un skill, lis d'abord son SKILL.md " +
      'complet avec `read_file`, puis suis ses instructions. Dans la VM, les skills sont ' +
      `en lecture seule sous \`${GUEST_SKILLS}\` : exécute leurs scripts depuis ce chemin ` +
      'et écris les résultats dans le dossier de travail.',
    '',
  ];
  for (const skill of skills) {
    const where = skill.guestPath ? `${skill.path} (VM : ${skill.guestPath})` : skill.path;
    lines.push(`- **${skill.name}** : ${skill.description}`, `  SKILL.md : ${where}`);
  }
  return lines.join('\n');
}
