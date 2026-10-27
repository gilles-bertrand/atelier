/**
 * @atelier/sandbox — VM d'exécution Lima (vz, virtiofs) pour l'agent.
 *
 * Point d'entrée : {@link LimaSandbox}, implémentation de l'interface `Sandbox`
 * de `@atelier/shared`. Voir docs/BRIEF.md §3 et lima/README.md.
 */
export {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_INSTANCE_NAME,
  DEFAULT_RESOURCES,
  LimaSandbox,
  MIN_FREE_BYTES_FOR_CREATE,
  type LimaSandboxOptions,
} from './lima-sandbox.js';
export { Limactl, parseLimaList, type LimaInstance, type LimaMount } from './limactl.js';
export { classifyLimaFailure } from './errors.js';
export { defaultLimaHome, defaultSkillsDir, guestToHost, hostToGuest } from './paths.js';
export { DEFAULT_MAX_OUTPUT_BYTES, OutputCollector } from './output.js';
export { spawnRunner, type CommandRunner, type RunOptions, type RunResult } from './runner.js';
