/**
 * Schémas d'entrée des outils MCP (JSON Schema) → Zod.
 *
 * `ToolDefinition.inputSchema` est un schéma Zod (contrat `shared`), que
 * agent-core repasse à l'AI SDK. `z.fromJSONSchema` couvre l'essentiel ; pour un
 * schéma qu'il ne sait pas convertir, on garde le JSON Schema d'origine en
 * métadonnée (ressorti tel quel par `z.toJSONSchema`) et on laisse le serveur MCP
 * valider l'entrée.
 */
import { z } from 'zod';

/** JSON Schema tel que publié par un serveur MCP. */
export type JsonSchemaObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise le schéma racine : un outil prend toujours un objet. */
export function normalizeInputSchema(schema: unknown): JsonSchemaObject {
  const base: JsonSchemaObject = isRecord(schema) ? { ...schema } : {};
  // Le dialecte n'apporte rien au modèle et gêne certaines conversions.
  delete base.$schema;
  if (base.type === undefined) base.type = 'object';
  if (base.type === 'object' && !isRecord(base.properties)) base.properties = {};
  return base;
}

/** Convertit le JSON Schema d'un outil MCP en schéma Zod. */
export function jsonSchemaToZod(schema: unknown): z.ZodType<Record<string, unknown>> {
  const normalized = normalizeInputSchema(schema);
  try {
    const converted = z.fromJSONSchema(normalized);
    // Vérifie que le schéma converti se ré-exporte (c'est ce que fera l'AI SDK).
    z.toJSONSchema(converted, { io: 'input', unrepresentable: 'any' });
    return converted as z.ZodType<Record<string, unknown>>;
  } catch {
    return z.looseObject({}).meta(normalized);
  }
}
