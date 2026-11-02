/**
 * `@atelier/voice` : voix locale (ADR-004).
 *
 * L1 : catalogue épinglé des modèles et `VoiceModelManager` (installation
 * atomique, reprise, contrôle SHA-256, miroir, import hors ligne).
 */
export * from './catalog.js';
export * from './archive.js';
export * from './manager.js';
