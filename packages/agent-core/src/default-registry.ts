import { InMemoryToolRegistry, type AnyToolDefinition, type ToolRegistry } from '@atelier/shared';
import { bashTool } from './tools/bash.js';
import { createNativeTools } from './tools/native.js';

/**
 * Registre par défaut : outils natifs + bash, plus les outils fournis
 * (documents, web, MCP…). Un outil fourni remplace l'outil natif de même nom
 * (ex. `read_file` de `packages/documents`).
 */
export function createDefaultRegistry(extra: readonly AnyToolDefinition[] = []): ToolRegistry {
  const overridden = new Set(extra.map((t) => t.name));
  const natives = [...createNativeTools(), bashTool as AnyToolDefinition].filter(
    (t) => !overridden.has(t.name),
  );
  return new InMemoryToolRegistry([...natives, ...extra]);
}
