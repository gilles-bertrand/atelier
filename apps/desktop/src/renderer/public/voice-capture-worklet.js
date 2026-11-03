/* global AudioWorkletProcessor, registerProcessor */
/**
 * Capture du micro (ADR-004 D3) : trames de 100 ms en PCM mono 16 kHz.
 *
 * Fichier de l'app, chargé par `audioWorklet.addModule` sous `script-src 'self'`
 * (ni `blob:` ni `data:`). L'`AudioContext` est créé à 16 kHz : Chromium
 * rééchantillonne le micro. Chaque trame est transférée au renderer (sans copie),
 * qui l'envoie au main par `voice:audio`. Rien n'est écrit sur le disque.
 */
const FRAME_SAMPLES = 1600;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.frame[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === FRAME_SAMPLES) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
