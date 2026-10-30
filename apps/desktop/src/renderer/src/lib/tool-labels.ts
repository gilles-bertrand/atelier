/**
 * Libellés lisibles des appels d'outils (blocs repliables du chat), pour un
 * non-développeur : « Lecture de rapport.pdf », « Recherche web : … ».
 */

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Coupe une chaîne trop longue pour un titre. */
export function truncate(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Dernier segment d'un chemin (`rapports/T3.xlsx` → `T3.xlsx`). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Hôte d'une URL, ou l'URL telle quelle. */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Repère d'un site (initiale et teinte stable, calculées à partir du domaine) :
 * remplace la favicon sans aucune requête vers le site cité.
 * `fr.wikipedia.org` → `W`, `statbel.fgov.be` → `S`.
 */
export function siteMark(url: string): { initial: string; hue: number } {
  const labels = hostname(url).split('.').filter(Boolean);
  // Sous-domaine de langue ou mobile (fr., en., m.) : le nom du site vient après.
  const main = (labels.length > 2 && (labels[0]?.length ?? 0) <= 2 ? labels[1] : labels[0]) ?? url;
  let hue = 0;
  for (const char of main) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  const initial = /[\p{L}\p{N}]/u.exec(main)?.[0] ?? '?';
  return { initial: initial.toLocaleUpperCase('fr'), hue };
}

/**
 * Nom du skill dont `read_file` lit le SKILL.md (`skills/xlsx/SKILL.md` → `xlsx`),
 * chaîne vide pour un SKILL.md sans dossier, `undefined` pour un autre fichier.
 */
export function skillName(input: unknown): string | undefined {
  const path = field(input, 'path');
  if (!path) return undefined;
  const parts = path.split(/[\\/]/).filter(Boolean);
  // Nom exact du loader de skills : un « skill.md » quelconque reste une lecture ordinaire.
  if (parts.at(-1) !== 'SKILL.md') return undefined;
  return parts.at(-2) ?? '';
}

/** URL http(s) sûre à ouvrir dans le navigateur, sinon `undefined`. */
export function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Libellé d'un appel d'outil. */
export function toolLabel(toolName: string, input: unknown): string {
  const path = field(input, 'path');
  const name = path ? fileName(path) : undefined;
  switch (toolName) {
    case 'read_file': {
      const skill = skillName(input);
      if (skill !== undefined)
        return skill ? `Consultation du skill ${skill}` : 'Consultation d’un skill';
      return name ? `Lecture de ${name}` : 'Lecture d’un fichier';
    }
    case 'write_file':
      return name ? `Écriture de ${name}` : 'Écriture d’un fichier';
    case 'edit_file':
      return name ? `Modification de ${name}` : 'Modification d’un fichier';
    case 'list_dir':
      return path && path !== '.' ? `Contenu de ${name ?? path}` : 'Contenu du dossier';
    case 'glob':
      return 'Recherche de fichiers';
    case 'grep': {
      const pattern = field(input, 'pattern');
      return pattern ? `Recherche de « ${truncate(pattern, 40)} »` : 'Recherche dans les fichiers';
    }
    case 'bash': {
      const command = field(input, 'command');
      return command ? `Commande : ${truncate(command, 50)}` : 'Commande';
    }
    case 'todo_write':
      return 'Mise à jour des tâches';
    case 'present_file':
      return name ? `Fichier : ${name}` : 'Présentation d’un fichier';
    case 'look_at':
      return name ? `Analyse de l’image ${name}` : 'Analyse d’une image';
    case 'web_search': {
      const query = field(input, 'query');
      return query ? `Recherche web : « ${truncate(query, 50)} »` : 'Recherche web';
    }
    case 'web_fetch': {
      const url = field(input, 'url');
      return url ? `Lecture de la page ${hostname(url)}` : 'Lecture d’une page web';
    }
    case 'tool_search':
      return 'Recherche de connecteurs';
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return `Connecteur ${mcp[1] ?? ''} : ${(mcp[2] ?? '').replace(/_/g, ' ')}`;
      return toolName.replace(/_/g, ' ');
    }
  }
}

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

/** « il y a 5 minutes », « hier », « 12 oct. ». */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'à l’instant';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
