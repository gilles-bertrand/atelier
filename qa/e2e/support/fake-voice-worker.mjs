/**
 * Faux worker de reconnaissance pour les e2e mock de la dictée (ADR-004 L5).
 *
 * Lancé à la place de `out/main/voice-worker.js` (voir `useFakeVoiceEngine`
 * dans `voice.ts`). Il parle le protocole main ↔ worker de `@atelier/voice`
 * (`protocol.ts`) sans modèle : le texte rendu est celui reçu en argument.
 *
 * Il ne « reconnaît » le texte que si le micro a vraiment envoyé de l'audio :
 * au moins `MIN_FRAMES` trames de 100 ms (1 600 échantillons à 16 kHz), non
 * nulles. Un texte inséré prouve donc que la capture, le relais du main et la
 * session ont fonctionné de bout en bout.
 *
 * Fichier JavaScript brut : un `utilityProcess` ne charge pas de TypeScript.
 */
const FRAME_SAMPLES = 1600;
/** Trames nécessaires avant le premier segment (0,8 s d'audio). */
const MIN_FRAMES = 8;

const port = process.parentPort;
const text = process.argv[2] ?? '';
/** Le texte est rendu en deux segments, comme un vrai découpage à la pause. */
const words = text.split(' ');
const firstPart = words.slice(0, Math.ceil(words.length / 2)).join(' ');

let loaded = false;
/** @type {{ id: string, frames: number, voiced: number, segments: number, startedAt: number } | undefined} */
let session;

const post = (message) => {
  port.postMessage(message);
};

function segment(index, segmentText) {
  const elapsed = Date.now() - (session?.startedAt ?? Date.now());
  post({
    type: 'transcript',
    segment: {
      voiceSessionId: session.id,
      index,
      text: segmentText,
      final: true,
      startMs: 0,
      endMs: elapsed,
    },
  });
}

port.on('message', (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'load':
      loaded = true;
      post({ type: 'loaded', loadMs: 1 });
      return;
    case 'start':
      if (!loaded || session !== undefined) {
        post({
          type: 'error',
          voiceSessionId: message.voiceSessionId,
          error: { code: 'voice/busy', message: 'Faux moteur occupé.', retryable: false },
        });
        return;
      }
      session = {
        id: message.voiceSessionId,
        frames: 0,
        voiced: 0,
        segments: 0,
        startedAt: Date.now(),
      };
      post({ type: 'state', voiceSessionId: session.id, state: 'starting' });
      return;
    case 'audio': {
      if (session?.id !== message.voiceSessionId) return;
      const pcm = message.pcm;
      if (!(pcm instanceof Float32Array) || pcm.length !== FRAME_SAMPLES) {
        post({ type: 'rejected', issue: 'pcm' });
        return;
      }
      session.frames += 1;
      if (pcm.some((v) => v !== 0)) session.voiced += 1;
      if (session.frames === 1) {
        post({ type: 'state', voiceSessionId: session.id, state: 'listening' });
      }
      if (session.segments === 0 && session.voiced >= MIN_FRAMES) {
        session.segments = 1;
        segment(0, firstPart);
      }
      return;
    }
    case 'stop': {
      if (session?.id !== message.voiceSessionId) return;
      const done = session;
      session = undefined;
      post({ type: 'state', voiceSessionId: done.id, state: 'transcribing' });
      const heard = done.voiced >= MIN_FRAMES;
      post({ type: 'final', voiceSessionId: done.id, text: heard ? text : '', reason: 'stopped' });
      return;
    }
    case 'cancel':
      if (session?.id === message.voiceSessionId) session = undefined;
      return;
    case 'shutdown':
      process.exit(0);
      return;
    default:
      post({ type: 'rejected', issue: 'type' });
  }
});

post({ type: 'ready' });
