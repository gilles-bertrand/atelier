/**
 * Point d'entrée du `utilityProcess` de la voix (ADR-004 D2), compilé en
 * `out/main/voice-worker.js` : reconnaissance, et synthèse chargée à la demande
 * (L7). Il ne fait aucun appel réseau, n'écrit rien sur le disque et ne reçoit
 * que des chemins de modèles validés par le main (§7).
 */
import { createSherpaEngine, createSherpaSynthesizer, runVoiceWorker } from '@atelier/voice';

const port = process.parentPort;

runVoiceWorker({
  port: {
    postMessage: (message) => {
      port.postMessage(message);
    },
    onMessage: (listener) => {
      port.on('message', (event) => {
        listener(event.data);
      });
    },
  },
  createEngine: (config) => createSherpaEngine(config),
  createSynthesizer: (config) => createSherpaSynthesizer(config),
  exit: () => {
    process.exit(0);
  },
});
