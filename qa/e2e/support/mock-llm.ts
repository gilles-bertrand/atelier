/**
 * Faux serveur LLM pour les e2e en mode « mock » (CI) : il parle l'API
 * OpenAI-compatible (`/v1/chat/completions`, streaming SSE ou non) et les
 * routes Ollama que l'app interroge (`/api/version`, `/api/tags`, `/api/show`,
 * `/api/ps`).
 *
 * Plusieurs modèles peuvent être servis (`MockModel`), avec leurs capacités et
 * leur fenêtre de contexte. Comme un Ollama réglé avec
 * `OLLAMA_MAX_LOADED_MODELS=1`, une seule entrée est en mémoire : une requête
 * de chat charge son modèle et décharge le précédent. L'état chargé se règle
 * par test (`setLoaded`). Un modèle sans `tools` refuse une requête avec
 * outils (HTTP 400 « does not support tools », message exact d'Ollama 0.40).
 *
 * Il rejoue des scénarios scriptés : le scénario est choisi d'après le dernier
 * message de l'utilisateur, l'étape d'après le nombre de réponses de
 * l'assistant depuis ce message. Les requêtes « vision » (une image dans le
 * message) reçoivent la réponse `vision` du scénario. Toutes les requêtes sont
 * gardées dans `requests` pour les assertions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_MODEL = 'atelier';
export const MOCK_CONTEXT = 32_768;

export type MockCapability = 'completion' | 'tools' | 'vision' | 'thinking' | 'embedding';

/** Modèle servi par le faux serveur (`/api/tags`, `/api/show`, `/api/ps`). */
export interface MockModel {
  /** Nom complet, tel que `/api/tags` le renvoie (`qwen3.5:9b`, `atelier:latest`). */
  name: string;
  /** `details.family` de `/api/tags` ; vide pour un modèle MLX (Ollama 0.40). */
  family: string;
  /** `details.family` de `/api/show` (défaut : `family`). */
  showFamily?: string;
  capabilities: MockCapability[];
  /** `num_ctx` du Modelfile (`parameters` de `/api/show`). */
  numCtx: number;
  sizeBytes?: number;
}

/** Modèle historique des e2e (critères 2 à 5) : un dérivé de qwen3.5 35b. */
export const DEFAULT_MOCK_MODELS: MockModel[] = [
  {
    name: `${MOCK_MODEL}:latest`,
    family: 'qwen35',
    capabilities: ['completion', 'vision', 'thinking', 'tools'],
    numCtx: MOCK_CONTEXT,
    sizeBytes: 21_909_194_194,
  },
];

export interface MockLlmOptions {
  /** Modèles installés (défaut {@link DEFAULT_MOCK_MODELS}). */
  models?: MockModel[];
  /**
   * Modèles en mémoire au démarrage (défaut : le premier). `undefined` explicite
   * via `setLoaded(undefined)` : `/api/ps` répond 404 (serveur sans la route, vLLM).
   */
  loaded?: string[];
}

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface MockStep {
  text?: string;
  reasoning?: string;
  toolCalls?: MockToolCall[];
  /** Tokens d'entrée annoncés (déclenche la compaction de l'app au-delà de 75 % du contexte). */
  promptTokens?: number;
  /** Attente avant la réponse (ms) : un tour qui dure, pour tester les refus « pendant un tour ». */
  delayMs?: number;
}

/** Contexte d'une étape : la conversation reçue, pour les étapes dynamiques. */
export interface StepContext {
  messages: ChatMessage[];
  /** Contenu des messages `tool` reçus depuis le message de l'utilisateur. */
  toolResults: string[];
}

export interface MockScenario {
  name: string;
  /** Vrai si ce scénario répond à ce message de l'utilisateur. */
  match: (userText: string) => boolean;
  steps: (MockStep | ((context: StepContext) => MockStep))[];
  /** Réponse aux requêtes vision (look_at, image ou page scannée) de ce scénario. */
  vision?: (question: string) => string;
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface RecordedRequest {
  path: string;
  /** Modèle demandé (`model` du corps de la requête). */
  model?: string;
  scenario?: string;
  step?: number;
  vision: boolean;
  tools: string[];
  messages: ChatMessage[];
}

export interface MockLlm {
  url: string;
  requests: RecordedRequest[];
  /** Règle les modèles en mémoire ; `undefined` : `/api/ps` répond 404 (état inconnu). */
  setLoaded: (names: string[] | undefined) => void;
  /** Modèles en mémoire ; `undefined` si `/api/ps` est désactivé. */
  loaded: () => string[] | undefined;
  close: () => Promise<void>;
}

/** Retrouve un modèle par son nom, avec ou sans l'étiquette implicite `:latest` (comme Ollama). */
export function findModel(models: readonly MockModel[], name: string): MockModel | undefined {
  return (
    models.find((m) => m.name === name) ??
    models.find((m) => !name.includes(':') && m.name === `${name}:latest`)
  );
}

/** Préfixe des messages de relance internes d'agent-core (invisibles dans l'UI). */
const INTERNAL_PREFIX = '[Atelier]';

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('\n');
}

function hasImage(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part: unknown) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        (part.type === 'image_url' || part.type === 'image'),
    )
  );
}

/** Choisit le scénario et l'étape d'une requête de chat. */
export function locate(
  messages: ChatMessage[],
  scenarios: MockScenario[],
): { scenario?: MockScenario; step: number; vision: boolean; question: string; userIndex: number } {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && !textOf(message.content).startsWith(INTERNAL_PREFIX)) {
      userIndex = i;
      break;
    }
  }
  const user = messages[userIndex];
  const question = user ? textOf(user.content) : '';
  const vision = user ? hasImage(user.content) : false;
  const step = messages.slice(userIndex + 1).filter((m) => m.role === 'assistant').length;
  if (vision) {
    // Requête vision isolée : on retrouve le scénario actif via ses réponses vision.
    const scenario = scenarios.find((s) => s.vision !== undefined && s.match(question));
    return {
      scenario: scenario ?? scenarios.find((s) => s.vision),
      step,
      vision,
      question,
      userIndex,
    };
  }
  return { scenario: scenarios.find((s) => s.match(question)), step, vision, question, userIndex };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let callCounter = 0;

function sendCompletion(
  res: ServerResponse,
  step: MockStep,
  stream: boolean,
  model: string = MOCK_MODEL,
): void {
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = (step.toolCalls ?? []).map((call, index) => ({
    index,
    id: `call_mock_${++callCounter}`,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const promptTokens = step.promptTokens ?? 1200;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: 40,
    total_tokens: promptTokens + 40,
  };

  if (!stream) {
    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: step.text ?? '',
            ...(toolCalls.length > 0
              ? { tool_calls: toolCalls.map(({ index: _i, ...c }) => c) }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): void => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  };
  chunk({ role: 'assistant', content: '' });
  if (step.reasoning) chunk({ reasoning: step.reasoning });
  if (step.text) {
    // Plusieurs deltas pour exercer le streaming de l'UI.
    for (const piece of step.text.match(/[\s\S]{1,24}/g) ?? []) chunk({ content: piece });
  }
  if (toolCalls.length > 0) chunk({ tool_calls: toolCalls });
  chunk({}, finishReason);
  res.write(
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function startMockLlm(
  scenarios: MockScenario[],
  options: MockLlmOptions = {},
): Promise<MockLlm> {
  const requests: RecordedRequest[] = [];
  const models = options.models ?? DEFAULT_MOCK_MODELS;
  const first = models[0];
  let loaded: string[] | undefined = options.loaded ?? (first ? [first.name] : []);

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (req.method === 'GET' && path === '/api/version') {
        json(res, 200, { version: '0.0.0-mock' });
        return;
      }
      if (req.method === 'GET' && path === '/api/tags') {
        json(res, 200, {
          models: models.map((m) => ({
            name: m.name,
            model: m.name,
            size: m.sizeBytes ?? 5_000_000_000,
            details: { family: m.family, parameter_size: 'mock', quantization_level: 'mock' },
            capabilities: m.capabilities,
          })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/api/show') {
        const body = JSON.parse((await readBody(req)) || '{}') as { model?: string; name?: string };
        const model = findModel(models, body.model ?? body.name ?? '');
        if (!model) {
          json(res, 404, { error: `model '${body.model ?? body.name ?? ''}' not found` });
          return;
        }
        const family = model.showFamily ?? model.family;
        json(res, 200, {
          parameters: `num_ctx ${String(model.numCtx)}`,
          details: { family },
          model_info: { [`${family || 'mock'}.context_length`]: 262_144 },
          capabilities: model.capabilities,
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/ps') {
        if (loaded === undefined) {
          json(res, 404, { error: 'route inconnue GET /api/ps' });
          return;
        }
        json(res, 200, {
          models: loaded.map((name) => ({
            name,
            model: name,
            context_length: findModel(models, name)?.numCtx ?? MOCK_CONTEXT,
          })),
        });
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.name, object: 'model' })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const body = JSON.parse(await readBody(req)) as {
          model?: string;
          messages?: ChatMessage[];
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
        };
        const messages = body.messages ?? [];
        const requested = body.model ?? MOCK_MODEL;
        const where = locate(messages, scenarios);
        const record: RecordedRequest = {
          path,
          model: requested,
          vision: where.vision,
          tools: (body.tools ?? []).map((t) => t.function?.name ?? '?'),
          messages,
          step: where.step,
          ...(where.scenario ? { scenario: where.scenario.name } : {}),
        };
        requests.push(record);

        const target = findModel(models, requested);
        if (!target) {
          json(res, 404, {
            error: {
              message: `model "${requested}" not found, try pulling it first`,
              type: 'api_error',
            },
          });
          return;
        }
        if ((body.tools ?? []).length > 0 && !target.capabilities.includes('tools')) {
          // Message exact d'Ollama 0.40.12 (observé pendant #15), avec ou sans streaming.
          json(res, 400, {
            error: {
              message: `${requested} does not support tools`,
              type: 'invalid_request_error',
            },
          });
          return;
        }
        // Un seul modèle en mémoire : la requête charge le sien, décharge les autres.
        if (loaded !== undefined) loaded = [target.name];
        const reply = (step: MockStep): void => {
          sendCompletion(res, step, body.stream === true, requested);
        };

        const isCompaction = messages.some(
          (m) => m.role === 'system' && textOf(m.content).startsWith('Tu résumes une conversation'),
        );
        if (isCompaction) {
          // Résumé de compaction d'agent-core (requête interne, sans outils) : texte simple.
          record.scenario = 'compaction';
          reply({
            text: 'Résumé : l’utilisateur a demandé une analyse ; les fichiers ont été lus.',
          });
          return;
        }
        if (where.vision) {
          const answer = where.scenario?.vision?.(where.question) ?? 'Image illisible.';
          reply({ text: answer });
          return;
        }
        const scripted = where.scenario?.steps[where.step];
        const toolResults = messages
          .slice(where.userIndex + 1)
          .filter((m) => m.role === 'tool')
          .map((m) => textOf(m.content));
        const step: MockStep =
          scripted === undefined
            ? { text: where.scenario ? 'Terminé.' : `Scénario inconnu : « ${where.question} »` }
            : typeof scripted === 'function'
              ? scripted({ messages, toolResults })
              : scripted;
        if (step.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
        reply(step);
        return;
      }
      json(res, 404, { error: `route inconnue ${req.method ?? ''} ${path}` });
    })().catch((error: unknown) => {
      json(res, 500, { error: String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    setLoaded: (names) => {
      loaded = names === undefined ? undefined : [...names];
    },
    loaded: () => (loaded === undefined ? undefined : [...loaded]),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Faux SearXNG sur 127.0.0.1:8888 (adresse fixe du fournisseur par défaut, la
 * VM n'existe pas en CI). Si le port est déjà pris (VM Lima locale qui
 * forwarde le vrai SearXNG), on laisse le vrai répondre : `undefined`.
 */
export async function startFakeSearxng(
  results: { title: string; url: string; content: string }[],
): Promise<{ close: () => Promise<void>; queries: string[] } | undefined> {
  const queries: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:8888');
    if (url.pathname === '/healthz') {
      res.end('OK');
      return;
    }
    if (url.pathname === '/search') {
      queries.push(url.searchParams.get('q') ?? '');
      json(res, 200, { query: url.searchParams.get('q'), results });
      return;
    }
    json(res, 404, {});
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => {
      resolve(false);
    });
    server.listen(8888, '127.0.0.1', () => {
      resolve(true);
    });
  });
  if (!listening) return undefined;
  return {
    queries,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
