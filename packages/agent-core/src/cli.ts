/**
 * CLI de démonstration de la boucle agentique.
 *
 *   pnpm --filter agent-core dev -- --dir ./demo
 *
 * Variables d'environnement : ATELIER_LLM_URL (défaut http://localhost:11434),
 * ATELIER_LLM_TOKEN (jeton Bearer, jamais en argument : il apparaîtrait dans `ps`),
 * ATELIER_MODEL (défaut qwen3.5:35b).
 *
 * ⚠️ `bash` s'exécute ici SANS isolation (LocalSandbox, M1) : la VM Lima n'est
 * pas encore branchée.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { parseArgs, styleText } from 'node:util';
import {
  DEFAULT_MODEL,
  type AgentEvent,
  type PermissionDecision,
  type PermissionHandler,
} from '@atelier/shared';
import {
  Agent,
  AgentSession,
  createDefaultRegistry,
  createLlmModels,
  fetchContextWindow,
  LocalSandbox,
  toLlmError,
  withSessionMemory,
} from './index.js';

const HELP = `Atelier — CLI de démonstration d'agent-core

Usage : pnpm --filter agent-core dev -- --dir <dossier> [options]

Options :
  --dir <chemin>     Dossier de travail (créé s'il n'existe pas)       [requis]
  --url <url>        Serveur LLM (env ATELIER_LLM_URL, défaut http://localhost:11434)
  --model <nom>      Modèle (env ATELIER_MODEL, défaut ${DEFAULT_MODEL})
  --no-thinking      Désactive le mode thinking de Qwen
  --num-ctx <n>      Force la fenêtre de contexte (sinon lue via /api/show)
  --yes              Accepte toutes les permissions (prudence !)
  --no-bash          N'expose pas l'outil bash
  -p, --prompt <t>   Exécute un seul message puis quitte (non interactif)
  -v, --verbose      Journal de diagnostic (réparations, compaction)
  -h, --help         Affiche cette aide

Le jeton se passe par la variable ATELIER_LLM_TOKEN.`;

function parse(): ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
> {
  // pnpm transmet parfois le séparateur `--` tel quel.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, allowNegative: true });
}

const OPTIONS = {
  dir: { type: 'string' },
  url: { type: 'string' },
  model: { type: 'string' },
  thinking: { type: 'boolean', default: true },
  'num-ctx': { type: 'string' },
  yes: { type: 'boolean', default: false },
  bash: { type: 'boolean', default: true },
  prompt: { type: 'string', short: 'p' },
  verbose: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const dim = (t: string): string => styleText('dim', t);
const cyan = (t: string): string => styleText('cyan', t);
const red = (t: string): string => styleText('red', t);
const green = (t: string): string => styleText('green', t);
const yellow = (t: string): string => styleText('yellow', t);

function oneLine(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Affichage des événements dans le terminal. */
function createRenderer(): (event: AgentEvent) => void {
  let mode: 'text' | 'reasoning' | 'none' = 'none';
  const switchTo = (next: typeof mode): void => {
    if (mode !== next && mode !== 'none') process.stdout.write('\n');
    if (next === 'reasoning' && mode !== 'reasoning') process.stdout.write(dim('💭 '));
    mode = next;
  };
  return (event) => {
    switch (event.type) {
      case 'text_delta':
        switchTo('text');
        process.stdout.write(event.delta);
        break;
      case 'reasoning_delta':
        switchTo('reasoning');
        process.stdout.write(dim(event.delta));
        break;
      case 'tool_start':
        switchTo('none');
        process.stdout.write(`${cyan(`▶ ${event.toolName}`)} ${dim(oneLine(event.input))}\n`);
        break;
      case 'tool_result': {
        switchTo('none');
        const mark = event.denied ? yellow('⊘ refusé') : event.ok ? green('✓') : red('✗');
        process.stdout.write(`  ${mark} ${dim(oneLine(event.output, 300))}\n`);
        break;
      }
      case 'todo_update':
        switchTo('none');
        for (const t of event.todos) {
          const box = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▣' : '☐';
          process.stdout.write(`  ${box} ${t.title}\n`);
        }
        break;
      case 'permission_request':
        switchTo('none');
        break;
      case 'sources':
        switchTo('none');
        process.stdout.write(dim(`Sources : ${event.sources.map((s) => s.url).join(', ')}\n`));
        break;
      case 'compaction':
        switchTo('none');
        process.stdout.write(
          yellow(`↺ Historique compacté (${event.replacedMessages} messages résumés)\n`),
        );
        break;
      case 'done':
        switchTo('none');
        process.stdout.write(
          dim(
            `— ${event.reason}${event.usage ? ` · contexte ${event.usage.inputTokens}/${event.usage.contextWindow ?? '?'} · sortie ${event.usage.outputTokens} tokens` : ''}\n`,
          ),
        );
        break;
      case 'error':
        switchTo('none');
        process.stdout.write(red(`Erreur [${event.error.code}] ${event.error.message}\n`));
        break;
    }
  };
}

/**
 * File de lignes au-dessus de readline : fonctionne aussi avec une entrée
 * redirigée (les lignes arrivées avant la question ne sont pas perdues).
 */
class LineQueue {
  readonly #lines: string[] = [];
  readonly #waiters: ((line: string | null) => void)[] = [];
  #closed = false;

  constructor(rl: Interface) {
    rl.on('line', (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    });
    rl.on('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  /** Affiche `prompt` et attend la ligne suivante (`null` si l'entrée est fermée ou annulée). */
  next(prompt: string, signal?: AbortSignal): Promise<string | null> {
    process.stdout.write(prompt);
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (line: string | null): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
      const onAbort = (): void => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

function interactivePermissions(lines: LineQueue): PermissionHandler {
  return async (request, signal) => {
    process.stdout.write(`\n${yellow('🔐 Permission demandée :')} ${request.title}\n`);
    if (request.detail !== undefined) {
      process.stdout.write(dim(`${request.detail.slice(0, 1_500)}\n`));
    }
    const line = await lines.next('Autoriser ? [o]ui une fois / [s]ession / [N]on : ', signal);
    const answer = (line ?? '').trim().toLowerCase();
    if (line !== null && !process.stdin.isTTY) process.stdout.write(`${line}\n`);
    const decision: PermissionDecision =
      answer === 'o' || answer === 'oui' || answer === 'y'
        ? 'allow_once'
        : answer === 's' || answer === 'session'
          ? 'allow_session'
          : 'deny';
    return decision;
  };
}

async function main(): Promise<number> {
  const { values } = parse();
  if (values.help || values.dir === undefined) {
    process.stdout.write(`${HELP}\n`);
    return values.help ? 0 : 1;
  }
  const workspace = path.resolve(values.dir);
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  const baseUrl = values.url ?? process.env['ATELIER_LLM_URL'] ?? 'http://localhost:11434';
  const model = values.model ?? process.env['ATELIER_MODEL'] ?? DEFAULT_MODEL;
  const token = process.env['ATELIER_LLM_TOKEN'];
  const numCtx = values['num-ctx'] !== undefined ? Number(values['num-ctx']) : undefined;
  const log = values.verbose
    ? (message: string, data?: Record<string, unknown>): void => {
        process.stderr.write(dim(`[${message}] ${data ? JSON.stringify(data) : ''}\n`));
      }
    : undefined;

  const llm = createLlmModels({
    baseUrl,
    model,
    thinking: values.thinking,
    ...(token !== undefined ? { token } : {}),
    retry: log
      ? {
          onRetry: (i) => {
            log('retry', i);
          },
        }
      : {},
  });
  const ctx = await fetchContextWindow({
    baseUrl,
    model,
    ...(token !== undefined ? { token } : {}),
    ...(numCtx !== undefined ? { override: numCtx } : {}),
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const lines = new LineQueue(rl);
  const ask: PermissionHandler = values.yes
    ? () => Promise.resolve('allow_once')
    : interactivePermissions(lines);
  const registry = createDefaultRegistry();
  if (!values.bash) registry.unregister('bash');
  const agent = new Agent({
    model: llm.model,
    fastModel: llm.fastModel,
    registry,
    workspace,
    requestPermission: withSessionMemory(ask),
    contextWindow: ctx.contextWindow,
    serverUrl: baseUrl,
    ...(values.bash ? { sandbox: new LocalSandbox(workspace) } : {}),
    ...(log ? { log } : {}),
    // Pas de VM en démo : /workspace n'existe pas, bash tourne dans le dossier.
    ...(values.bash
      ? {
          extraInstructions:
            "Mode démonstration : la commande bash s'exécute directement dans le dossier de travail (répertoire courant). Le chemin /workspace n'existe pas : utilise des chemins relatifs.",
        }
      : {}),
  });
  const session = new AgentSession(agent, `cli-${Date.now()}`);
  const render = createRenderer();

  process.stdout.write(
    `${cyan('Atelier')} · ${model} @ ${llm.apiBaseUrl} · contexte ${ctx.contextWindow} (${ctx.source}) · thinking ${values.thinking ? 'on' : 'off'}\n` +
      `Dossier : ${workspace}\n` +
      (values.bash
        ? yellow('⚠ bash sans isolation (M1) : les commandes tournent sur cette machine.\n')
        : '') +
      dim('Ctrl+C interrompt le tour en cours ; Ctrl+D ou /quit pour quitter.\n'),
  );

  let current: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (current) current.abort(new Error('Interrompu par l’utilisateur'));
    else rl.close();
  });

  const runOnce = async (input: string): Promise<void> => {
    current = new AbortController();
    const started = Date.now();
    await session.send(input, render, current.signal);
    log?.('turn', { durationMs: Date.now() - started });
    current = undefined;
  };

  try {
    if (values.prompt !== undefined) {
      await runOnce(values.prompt);
      return 0;
    }
    for (;;) {
      const line = await lines.next(`\n${green('›')} `);
      if (line === null) break; // Ctrl+D / fermeture
      const input = line.trim();
      if (input === '') continue;
      if (input === '/quit' || input === '/exit') break;
      await runOnce(input);
    }
    return 0;
  } finally {
    rl.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const e = toLlmError(error);
    process.stderr.write(red(`Erreur [${e.code}] ${e.message}\n`));
    process.exitCode = 1;
  },
);
