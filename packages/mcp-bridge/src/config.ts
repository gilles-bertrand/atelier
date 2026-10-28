/**
 * Lecture de `~/Atelier/mcp.json`, au format de Claude Desktop :
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "fichiers": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"] },
 *     "notion":   { "type": "http", "url": "https://mcp.notion.com/mcp", "headers": { "Authorization": "Bearer …" } }
 *   }
 * }
 * ```
 *
 * Un serveur invalide est ignoré (avec une erreur lisible) sans bloquer les
 * autres ; seul un JSON illisible rend toute la configuration invalide.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AtelierError } from '@atelier/shared';

/** Serveur lancé localement (processus enfant, stdio). */
export interface McpStdioServerConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** Serveur distant (streamable HTTP). */
export interface McpHttpServerConfig {
  name: string;
  transport: 'http';
  url: string;
  headers: Record<string, string>;
}

/** Configuration d'un serveur MCP. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Erreur de configuration propre à un serveur. */
export interface McpConfigIssue {
  /** Nom du serveur concerné. */
  server: string;
  /** Message en français. */
  message: string;
}

/** Configuration lue et validée. */
export interface McpConfig {
  /** Serveurs valides et actifs. */
  servers: McpServerConfig[];
  /** Serveurs désactivés (`"disabled": true`). */
  disabled: string[];
  /** Serveurs ignorés car invalides. */
  issues: McpConfigIssue[];
}

/** Chemin par défaut : `~/Atelier/mcp.json`. */
export function defaultMcpConfigPath(home: string = homedir()): string {
  return join(home, 'Atelier', 'mcp.json');
}

/** Nom de serveur accepté (il finit dans `mcp__<serveur>__<outil>`). */
const SERVER_NAME = /^[\p{L}\p{N}_. -]{1,40}$/u;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const stringRecord = z.record(z.string(), z.string());

const stdioSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().trim().min(1, 'commande vide'),
  args: z.array(z.string()).default([]),
  env: stringRecord.default({}),
  cwd: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
});

const httpSchema = z.object({
  type: z.enum(['http', 'streamable-http', 'streamableHttp']).optional(),
  url: z.string().min(1, 'URL vide'),
  headers: stringRecord.default({}),
  disabled: z.boolean().optional(),
});

const fileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')} : ${i.message}` : i.message))
    .join(' ; ');
}

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path;
}

/** Valide l'URL d'un serveur distant : https, ou http limité à la machine locale. */
function checkUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `URL invalide : ${raw}`;
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return undefined;
  return 'URL refusée : https obligatoire (http seulement pour localhost)';
}

/** Valide un objet de configuration déjà parsé. */
export function parseMcpConfig(data: unknown, home: string = homedir()): McpConfig {
  const file = fileSchema.safeParse(data);
  if (!file.success) {
    throw new AtelierError('mcp/config_invalid', `mcp.json invalide : ${zodMessage(file.error)}`);
  }
  const config: McpConfig = { servers: [], disabled: [], issues: [] };
  for (const [name, raw] of Object.entries(file.data.mcpServers)) {
    const issue = (message: string): void => {
      config.issues.push({ server: name, message });
    };
    if (!SERVER_NAME.test(name)) {
      issue(
        'nom de serveur invalide (lettres, chiffres, espaces, « _ », « - », « . », 40 caractères max)',
      );
      continue;
    }
    if (typeof raw !== 'object' || raw === null) {
      issue('la configuration doit être un objet');
      continue;
    }
    const type = (raw as { type?: unknown }).type;
    if (type === 'sse') {
      issue('transport SSE non pris en charge : utilise "type": "http" (streamable HTTP)');
      continue;
    }
    const isHttp = 'url' in raw || (typeof type === 'string' && type !== 'stdio');
    if (isHttp) {
      const parsed = httpSchema.safeParse(raw);
      if (!parsed.success) {
        issue(zodMessage(parsed.error));
        continue;
      }
      const urlProblem = checkUrl(parsed.data.url);
      if (urlProblem) {
        issue(urlProblem);
        continue;
      }
      if (parsed.data.disabled === true) {
        config.disabled.push(name);
        continue;
      }
      config.servers.push({
        name,
        transport: 'http',
        url: parsed.data.url,
        headers: parsed.data.headers,
      });
      continue;
    }
    const parsed = stdioSchema.safeParse(raw);
    if (!parsed.success) {
      issue(zodMessage(parsed.error));
      continue;
    }
    if (parsed.data.disabled === true) {
      config.disabled.push(name);
      continue;
    }
    config.servers.push({
      name,
      transport: 'stdio',
      command: expandHome(parsed.data.command, home),
      args: parsed.data.args,
      env: parsed.data.env,
      ...(parsed.data.cwd !== undefined ? { cwd: expandHome(parsed.data.cwd, home) } : {}),
    });
  }
  return config;
}

/**
 * Parse le texte de `mcp.json`.
 * @throws AtelierError `mcp/config_invalid` si le JSON est illisible.
 */
export function parseMcpConfigText(text: string, home?: string): McpConfig {
  if (text.trim() === '') return { servers: [], disabled: [], issues: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AtelierError(
      'mcp/config_invalid',
      `mcp.json n'est pas un JSON valide : ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseMcpConfig(data, home);
}

/**
 * Lit `mcp.json` ; un fichier absent donne une configuration vide.
 * @throws AtelierError `mcp/config_invalid`.
 */
export async function loadMcpConfig(
  path: string = defaultMcpConfigPath(),
  home?: string,
): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { servers: [], disabled: [], issues: [] };
    throw new AtelierError('mcp/config_invalid', `Lecture impossible de ${path}`, { cause: error });
  }
  return parseMcpConfigText(text, home);
}
