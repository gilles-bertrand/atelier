/**
 * Réparation des appels d'outils mal formés (`repairToolCall` de l'AI SDK,
 * anciennement `experimental_repairToolCall`). Fréquent avec les modèles locaux :
 * nom d'outil approximatif, JSON invalide, arguments enveloppés.
 *
 * Réparation déterministe (sans rappeler le modèle) ; si elle échoue, on renvoie
 * `null` et l'AI SDK transmet l'erreur au modèle, qui peut corriger au tour suivant.
 */
import {
  InvalidToolInputError,
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';
import { matchToolName, parseLooseJson } from './text-tool-calls.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Corrige un texte d'arguments : retire les balises/blocs de code, tolère les
 * virgules finales et guillemets simples, et désenveloppe `{"arguments": {...}}`
 * ou `{"name": ..., "arguments": ...}`.
 */
export function repairToolInput(raw: string): Record<string, unknown> | undefined {
  const stripped = raw
    .trim()
    .replace(/^<tool_call>|<\/tool_call>$/g, '')
    .replace(/^```(?:json)?\s*|```$/g, '')
    .trim();
  let value = parseLooseJson(stripped);
  // Arguments doublement encodés : "{\"path\": ...}".
  if (typeof value === 'string') value = parseLooseJson(value);
  if (!isRecord(value)) return undefined;
  for (const key of ['arguments', 'parameters', 'args', 'input']) {
    const inner = value[key];
    if (Object.keys(value).every((k) => k === key || k === 'name')) {
      if (isRecord(inner)) return inner;
      if (typeof inner === 'string') {
        const parsed = parseLooseJson(inner);
        if (isRecord(parsed)) return parsed;
      }
    }
  }
  return value;
}

/** Fabrique la fonction de réparation passée à `streamText`. */
export function createToolCallRepair<TOOLS extends ToolSet>(
  onRepair?: (info: { toolName: string; kind: 'name' | 'input' }) => void,
): ToolCallRepairFunction<TOOLS> {
  return ({ toolCall, tools, error }) => {
    const names = Object.keys(tools);
    if (NoSuchToolError.isInstance(error)) {
      const name = matchToolName(toolCall.toolName, names);
      if (name === undefined) return Promise.resolve(null);
      onRepair?.({ toolName: name, kind: 'name' });
      const fixed = repairToolInput(toolCall.input);
      return Promise.resolve({
        ...toolCall,
        toolName: name,
        input: fixed !== undefined ? JSON.stringify(fixed) : toolCall.input,
      });
    }
    if (InvalidToolInputError.isInstance(error)) {
      const fixed = repairToolInput(toolCall.input);
      if (fixed === undefined) return Promise.resolve(null);
      const input = JSON.stringify(fixed);
      // Rien à réparer : laisser l'erreur de validation remonter au modèle.
      if (input === toolCall.input.trim()) return Promise.resolve(null);
      onRepair?.({ toolName: toolCall.toolName, kind: 'input' });
      return Promise.resolve({ ...toolCall, input });
    }
    return Promise.resolve(null);
  };
}
