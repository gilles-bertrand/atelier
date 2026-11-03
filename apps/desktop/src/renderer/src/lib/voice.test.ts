import { describe, expect, it } from 'vitest';
import { DEFAULT_STT_MODEL, type VoiceModelInfo, type VoiceStatus } from '@atelier/shared';
import {
  approxDownloadSize,
  composeDictation,
  dictationBlocker,
  formatElapsed,
  isDictationShortcut,
  joinSegments,
  micLevel,
  spokenElapsed,
} from './voice';

const model = (state: VoiceModelInfo['state']): VoiceModelInfo => ({
  id: DEFAULT_STT_MODEL,
  role: 'stt',
  label: 'Parakeet v3',
  version: '1',
  languages: ['fr'],
  downloadBytes: 487_000_000,
  diskBytes: 640_000_000,
  memoryEstimateBytes: 1_500_000_000,
  license: 'CC-BY-4.0',
  bundled: false,
  state,
});

const status = (mic: VoiceStatus['mic'], state: VoiceModelInfo['state']): VoiceStatus => ({
  mic,
  engine: 'stopped',
  models: [model(state)],
});

describe('composeDictation', () => {
  it('insère au curseur avec une espace de chaque côté', () => {
    expect(composeDictation('Bonjour', 'cher ami', 'comment vas-tu')).toEqual({
      value: 'Bonjour cher ami comment vas-tu',
      cursor: 'Bonjour cher ami'.length,
    });
  });

  it('n’ajoute pas d’espace en double ni devant la ponctuation', () => {
    expect(composeDictation('Bonjour ', 'cher ami', ', ça va').value).toBe(
      'Bonjour cher ami, ça va',
    );
    expect(composeDictation('', 'Texte dicté.', '').value).toBe('Texte dicté.');
  });

  it('laisse le texte intact si rien n’a été dicté', () => {
    expect(composeDictation('avant ', '  ', 'après')).toEqual({
      value: 'avant après',
      cursor: 6,
    });
  });
});

describe('joinSegments', () => {
  it('assemble dans l’ordre, en sautant les trous et les vides', () => {
    const segments: (string | undefined)[] = [];
    segments[0] = 'Bonjour.';
    segments[2] = ' Comment ça va ? ';
    segments[3] = '';
    expect(joinSegments(segments)).toBe('Bonjour. Comment ça va ?');
  });

  it('retire le point d’une pause au milieu d’une phrase (#42)', () => {
    expect(
      joinSegments(['Le client veut une démo jeudi après-midi.', 'en néerlandais, si possible.']),
    ).toBe('Le client veut une démo jeudi après-midi en néerlandais, si possible.');
    expect(joinSegments(['Read the report.', 'and send it.'])).toBe('Read the report and send it.');
    expect(joinSegments(['Lees het rapport.', 'en stuur het.'])).toBe(
      'Lees het rapport en stuur het.',
    );
    expect(joinSegments(['Is het klaar?', 'ja.'])).toBe('Is het klaar? ja.');
  });
});

describe('micLevel', () => {
  it('vaut 0 pour le silence et monte avec le signal', () => {
    expect(micLevel(new Float32Array(1600))).toBe(0);
    const quiet = micLevel(new Float32Array(1600).fill(0.01));
    const loud = micLevel(new Float32Array(1600).fill(0.5));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(micLevel(new Float32Array(10).fill(1))).toBe(1);
  });
});

describe('chronomètre et tailles', () => {
  it('formate le temps écoulé', () => {
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(299_999)).toBe('4:59');
    expect(spokenElapsed(67_000)).toBe('1 minute 7 secondes');
  });

  it('annonce la taille du modèle arrondie à 10 Mo', () => {
    expect(approxDownloadSize(487_000_000)).toBe('environ 490 Mo');
  });
});

describe('isDictationShortcut', () => {
  const key = (
    k: string,
    mods: Partial<Record<'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey', boolean>>,
  ) => ({
    key: k,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...mods,
  });
  it('reconnaît ⌘⇧D et rien d’autre', () => {
    expect(isDictationShortcut(key('D', { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isDictationShortcut(key('d', { metaKey: true }))).toBe(false);
    expect(isDictationShortcut(key('k', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isDictationShortcut(key('D', { metaKey: true, shiftKey: true, altKey: true }))).toBe(
      false,
    );
  });
});

describe('dictationBlocker', () => {
  it('demande d’abord le micro, puis le modèle', () => {
    expect(dictationBlocker(status('denied', 'absent'), undefined)).toBe('mic_denied');
    expect(dictationBlocker(status('restricted', 'installed'), undefined)).toBe('mic_denied');
    expect(dictationBlocker(status('granted', 'absent'), undefined)).toBe('model');
    expect(dictationBlocker(status('granted', 'error'), undefined)).toBe('model');
    expect(dictationBlocker(status('not-determined', 'installed'), undefined)).toBeUndefined();
    expect(dictationBlocker(status('granted', 'loaded'), undefined)).toBeUndefined();
  });

  it('cherche le modèle choisi dans les réglages', () => {
    expect(dictationBlocker(status('granted', 'installed'), { sttModel: 'autre' })).toBe('model');
  });
});
