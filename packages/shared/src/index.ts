/**
 * @atelier/shared — types et contrats partagés d'Atelier.
 *
 * ⚠️ Toute modification de ce package passe par le Lead (voir CLAUDE.md) :
 * c'est le contrat entre agent-core, sandbox, web, mcp-bridge, documents,
 * skills et apps/desktop.
 *
 * Aucune dépendance runtime lourde : importable depuis le renderer.
 */
export * from './errors.js';
export * from './events.js';
export * from './ipc.js';
export * from './llm.js';
export * from './messages.js';
export * from './permissions.js';
export * from './sandbox.js';
export * from './search.js';
export * from './settings.js';
export * from './skills.js';
export * from './todo.js';
export * from './tools.js';
