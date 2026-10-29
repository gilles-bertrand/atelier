/**
 * Repli pour les modèles locaux qui écrivent l'appel d'outil dans le texte au
 * lieu d'utiliser le tool calling natif. Formats reconnus :
 *
 * - Hermes / Qwen : `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` ;
 * - Qwen3-Coder / Qwen 3.5 : `<tool_call><function=nom><parameter=x>valeur</parameter></function></tool_call>` ;
 * - JSON nu ou dans un bloc ```json : `{"name": "...", "arguments": {...}}`
 *   (variantes `tool`/`function`, `parameters`/`args`/`input`).
 *
 * Seuls les noms d'outils connus sont acceptés.
 *
 * Sécurité (brief §8) : le contenu des fichiers, du web et du MCP est de la
 * donnée. Le repli ne s'applique que si l'appel ouvre la réponse (au plus un
 * court préambule, hors bloc de code), et jamais à un appel qui figure déjà
 * dans un résultat d'outil ou un message de la conversation (recopie de donnée).
 */
import { randomUUID } from 'node:crypto';
import type {
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';

/** Appel d'outil extrait du texte. */
export interface TextToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** Résultat de l'analyse d'un texte. */
export interface ParsedTextToolCalls {
  calls: TextToolCall[];
  /** Texte hors appels (à afficher normalement). */
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise un nom d'outil (`functions.write_file`, casse…) vers un outil connu. */
export function matchToolName(raw: string, toolNames: readonly string[]): string | undefined {
  const cleaned = raw.trim().replace(/^(functions?|tools?)[.:/]/i, '');
  if (toolNames.includes(cleaned)) return cleaned;
  const lower = cleaned.toLowerCase().replace(/[\s-]+/g, '_');
  return toolNames.find((n) => n.toLowerCase() === lower);
}

/** Essaie de parser du JSON, en tolérant quelques défauts fréquents des modèles locaux. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Virgules finales, puis guillemets simples.
    const noTrailing = trimmed.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(noTrailing);
    } catch {
      try {
        return JSON.parse(noTrailing.replace(/'/g, '"'));
      } catch {
        return undefined;
      }
    }
  }
}

function callFromObject(value: unknown, toolNames: readonly string[]): TextToolCall | undefined {
  if (!isRecord(value)) return undefined;
  // {"function": {"name", "arguments"}} (format OpenAI recopié).
  if (isRecord(value['function'])) return callFromObject(value['function'], toolNames);
  const rawName = value['name'] ?? value['tool'] ?? value['tool_name'] ?? value['function'];
  if (typeof rawName !== 'string') return undefined;
  const toolName = matchToolName(rawName, toolNames);
  if (toolName === undefined) return undefined;
  let args: unknown =
    value['arguments'] ?? value['parameters'] ?? value['args'] ?? value['input'] ?? {};
  if (typeof args === 'string') args = parseLooseJson(args);
  return isRecord(args) ? { toolName, input: args } : undefined;
}

function parseXmlFunction(body: string, toolNames: readonly string[]): TextToolCall | undefined {
  const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (!fn?.[1]) return undefined;
  const toolName = matchToolName(fn[1], toolNames);
  if (toolName === undefined) return undefined;
  const input: Record<string, unknown> = {};
  const paramRe = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  for (const m of (fn[2] ?? '').matchAll(paramRe)) {
    const key = m[1];
    if (key === undefined) continue;
    const raw = m[2] ?? '';
    // Les valeurs non-chaîne (nombres, booléens, tableaux) sont écrites en JSON.
    const parsed = /^\s*[[{\d\-tfn]/.test(raw) ? parseLooseJson(raw) : undefined;
    input[key] = parsed !== undefined ? parsed : raw;
  }
  return { toolName, input };
}

/**
 * Extrait les appels d'outils écrits dans `text`. Renvoie `null` si aucun appel
 * valide vers un outil connu n'est trouvé.
 */
export function parseTextToolCalls(
  text: string,
  toolNames: readonly string[],
): ParsedTextToolCalls | null {
  const calls: TextToolCall[] = [];
  let rest = text;

  // 1. Balises <tool_call>…</tool_call> (fermeture parfois oubliée en fin de texte).
  const tagRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  if (tagRe.test(text)) {
    tagRe.lastIndex = 0;
    for (const m of text.matchAll(tagRe)) {
      const body = (m[1] ?? '').trim();
      const call = body.startsWith('<function=')
        ? parseXmlFunction(body, toolNames)
        : callFromObject(parseLooseJson(stripFence(body)), toolNames);
      if (call) calls.push(call);
    }
    rest = text.replace(tagRe, '');
  } else if (/<function=/.test(text)) {
    // 2. Format XML sans enveloppe <tool_call>.
    const start = text.indexOf('<function=');
    const call = parseXmlFunction(text.slice(start), toolNames);
    if (call) {
      calls.push(call);
      rest = text.slice(0, start);
    }
  } else {
    // 3. Bloc ```json … ``` ou JSON nu (texte entier).
    const fence = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/.exec(text);
    const candidate = fence ? (fence[1] ?? '') : text;
    const parsed = parseLooseJson(candidate);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const call = callFromObject(item, toolNames);
      if (call) calls.push(call);
    }
    if (calls.length > 0) rest = fence ? text.replace(fence[0], '') : '';
  }

  return calls.length > 0 ? { calls, text: rest.trim() } : null;
}

function stripFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)```$/.exec(text.trim());
  return m?.[1] ?? text;
}

/** Longueur max. du texte qui peut précéder un appel écrit (« Je lis le fichier. »). */
export const MAX_TEXT_CALL_PREAMBLE = 160;

/**
 * Vrai si le texte qui précède un appel écrit permet de le traiter comme un
 * appel : court, et pas à l'intérieur d'un bloc de code (nombre impair de ```).
 */
export function isCallPreambleAllowed(preamble: string): boolean {
  if (preamble.trim().length > MAX_TEXT_CALL_PREAMBLE) return false;
  const fences = preamble.match(/```/g)?.length ?? 0;
  return fences === 0;
}

function signature(call: TextToolCall): string {
  return `${call.toolName}\u0000${stableJson(call.input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Textes de données de la requête : résultats d'outils et messages utilisateur. */
function dataTexts(prompt: LanguageModelV4Prompt): string[] {
  const texts: string[] = [];
  for (const message of prompt) {
    if (message.role === 'user') {
      for (const part of message.content) if (part.type === 'text') texts.push(part.text);
    } else if (message.role === 'tool' || message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const out = part.output;
        texts.push(
          out.type === 'text' || out.type === 'error-text'
            ? out.value
            : JSON.stringify('value' in out ? out.value : out),
        );
      }
    }
  }
  return texts;
}

/**
 * Signatures (outil + arguments) des appels écrits présents dans les données de
 * la requête : un appel identique produit par le modèle est une recopie.
 */
export function quotedCallSignatures(
  prompt: LanguageModelV4Prompt,
  toolNames: readonly string[],
): Set<string> {
  const found = new Set<string>();
  for (const text of dataTexts(prompt)) {
    if (!/<tool_call>|<function=|"(?:name|tool|function)"\s*:/.test(text)) continue;
    // Chaque bloc <tool_call>, chaque <function=…>, et le JSON nu éventuel.
    const pieces = [
      ...text.matchAll(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g),
      ...text.matchAll(/<function=[\s\S]*?(?:<\/function>|$)/g),
      ...text.matchAll(/\{[\s\S]*\}/g),
    ].map((m) => m[0]);
    for (const piece of [text, ...pieces]) {
      for (const call of parseTextToolCalls(piece, toolNames)?.calls ?? []) {
        found.add(signature(call));
      }
    }
  }
  return found;
}

/** Texte retenu avant la première balise d'appel (ex. ouverture d'un bloc ```markdown). */
function tagPrefix(buffer: string): string {
  const indexes = ['<tool_call>', '<function='].map((m) => buffer.indexOf(m)).filter((i) => i >= 0);
  return indexes.length > 0 ? buffer.slice(0, Math.min(...indexes)) : '';
}

/** Marqueurs qui déclenchent la mise en attente du texte. */
const MARKERS = ['<tool_call>', '<function=', '```json'];

/** Longueur du plus long suffixe de `text` qui est un préfixe d'un marqueur. */
function partialMarkerTail(text: string): number {
  let best = 0;
  for (const marker of MARKERS) {
    for (let len = Math.min(marker.length - 1, text.length); len > best; len--) {
      if (text.endsWith(marker.slice(0, len))) {
        best = len;
        break;
      }
    }
  }
  return best;
}

/**
 * Middleware de modèle : convertit en vrais appels d'outils le JSON/XML écrit
 * dans le texte d'une étape sans appel natif. Le texte normal est streamé sans
 * délai ; seul le texte à partir d'un marqueur (ou commençant par `{`/```) est
 * retenu jusqu'à la fin du bloc pour être analysé.
 */
export function textToolCallMiddleware(
  generateId: () => string = () => `call_txt_${randomUUID().slice(0, 8)}`,
): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      const toolNames = (params.tools ?? [])
        .filter((t) => t.type === 'function')
        .map((t) => t.name);
      if (toolNames.length === 0) return result;

      let nativeToolCall = false;
      let converted = false;
      // Texte déjà émis pendant cette étape (préambule d'un éventuel appel écrit).
      let emittedText = '';
      let quoted: Set<string> | undefined;
      const isQuoted = (call: TextToolCall): boolean => {
        quoted ??= quotedCallSignatures(params.prompt, toolNames);
        return quoted.has(signature(call));
      };
      const emitText = (
        controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
        id: string,
        delta: string,
      ): void => {
        emittedText += delta;
        controller.enqueue({ type: 'text-delta', id, delta });
      };
      let emittedAny = false;
      let holding = false;
      let buffer = '';

      const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          switch (part.type) {
            case 'tool-call':
            case 'tool-input-start':
              nativeToolCall = true;
              controller.enqueue(part);
              return;
            case 'text-delta': {
              buffer += part.delta;
              if (!holding) {
                const lead = buffer.trimStart();
                if (
                  !emittedAny &&
                  (lead.startsWith('{') || lead.startsWith('```') || lead.startsWith('['))
                ) {
                  holding = true;
                } else {
                  const idx = Math.min(
                    ...MARKERS.map((m) => buffer.indexOf(m)).filter((i) => i >= 0),
                  );
                  if (Number.isFinite(idx)) {
                    if (idx > 0) emitText(controller, part.id, buffer.slice(0, idx));
                    emittedAny = emittedAny || idx > 0;
                    buffer = buffer.slice(idx);
                    holding = true;
                  } else {
                    const keep = partialMarkerTail(buffer);
                    const out = buffer.slice(0, buffer.length - keep);
                    if (out !== '') {
                      emitText(controller, part.id, out);
                      emittedAny = emittedAny || out.trim() !== '';
                    }
                    buffer = buffer.slice(buffer.length - keep);
                  }
                }
              }
              return;
            }
            case 'text-end': {
              if (buffer !== '') {
                const parsed =
                  holding &&
                  !nativeToolCall &&
                  isCallPreambleAllowed(emittedText + tagPrefix(buffer))
                    ? parseTextToolCalls(buffer, toolNames)
                    : null;
                // Un appel recopié depuis des données (fichier, web, MCP) n'est jamais exécuté.
                if (parsed?.calls.some(isQuoted)) parsed.calls = [];
                if (parsed && parsed.calls.length > 0) {
                  if (parsed.text !== '') emitText(controller, part.id, parsed.text);
                  controller.enqueue(part);
                  for (const call of parsed.calls) {
                    controller.enqueue({
                      type: 'tool-call',
                      toolCallId: generateId(),
                      toolName: call.toolName,
                      input: JSON.stringify(call.input),
                    });
                  }
                  converted = true;
                } else {
                  emitText(controller, part.id, buffer);
                  controller.enqueue(part);
                }
              } else {
                controller.enqueue(part);
              }
              buffer = '';
              holding = false;
              emittedAny = false;
              return;
            }
            case 'finish':
              controller.enqueue(
                converted
                  ? { ...part, finishReason: { unified: 'tool-calls', raw: part.finishReason.raw } }
                  : part,
              );
              return;
            default:
              controller.enqueue(part);
          }
        },
      });
      return { ...result, stream: result.stream.pipeThrough(transform) };
    },
  };
}
