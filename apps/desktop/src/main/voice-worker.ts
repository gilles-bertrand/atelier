/**
 * Point d'entrée du `utilityProcess` de reconnaissance (ADR-004 D2), compilé en
 * `out/main/voice-worker.js`. Il ne fait aucun appel réseau et ne reçoit que
 * des chemins de modèles validés par le main (§7).
 */
import { createSherpaEngine, runVoiceWorker } from '@atelier/voice';

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
  exit: () => {
    process.exit(0);
  },
});
