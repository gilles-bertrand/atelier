import { describe, expect, it } from 'vitest';
import {
  AtelierError,
  VOICE_CONVERSATION_IDLE_MS,
  VOICE_ECHO_GUARD_MS,
  VOICE_FRAME_SAMPLES,
  type AgentEvent,
  type IpcEventChannel,
  type PermissionRequest,
  type VoiceAudioOut,
  type VoiceSessionState,
} from '@atelier/shared';
import type { ToolWaitPhrase } from '@atelier/agent-core';
import {
  PERMISSION_PHRASE,
  VoiceConversation,
  isStopCommand,
  type ConversationAgent,
  type ConversationEndReason,
  type ConversationListener,
  type ConversationSpeech,
  type ConversationTimers,
  type SpeechSink,
} from './conversation.js';

const SESSION = 'chat-1';
const frame = (): Float32Array => new Float32Array(VOICE_FRAME_SAMPLES).fill(0.2);

/** Horloge simulée : les minuteries ne partent que sur `advance`. */
class FakeClock implements ConversationTimers {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = end;
  }
}

/** Reconnaissance simulée : `stop` rend le texte que le test lui donne. */
class FakeListener implements ConversationListener {
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  readonly audioFor: string[] = [];
  readonly options: { maxDurationMs: number; endOfTurnSilenceMs: number }[] = [];
  nextText = '';
  failStop = false;

  start(listenId: string, options: { maxDurationMs: number; endOfTurnSilenceMs: number }) {
    this.started.push(listenId);
    this.options.push(options);
    return Promise.resolve();
  }

  stop(): Promise<string> {
    if (this.failStop) return Promise.reject(new AtelierError('voice/engine_failed', 'x'));
    return Promise.resolve(this.nextText);
  }

  cancel(listenId: string): void {
    this.cancelled.push(listenId);
  }

  audio(listenId: string): void {
    this.audioFor.push(listenId);
  }

  get current(): string | undefined {
    const last = this.started.at(-1);
    return last !== undefined && !this.cancelled.includes(last) ? last : undefined;
  }
}

/** Voix simulée : enregistre les appels ; le test fait sortir l'audio par `sink`. */
class FakeSpeech implements ConversationSpeech {
  readonly calls: string[] = [];
  readonly texts = new Map<string, string>();
  sink!: SpeechSink;
  private seq = 0;
  private turnId: string | undefined;

  begin(turnId: string): void {
    this.calls.push(`begin:${turnId}`);
    this.turnId = turnId;
    this.texts.set(turnId, '');
  }

  push(turnId: string, delta: string): void {
    this.calls.push(`push:${delta}`);
    this.texts.set(turnId, (this.texts.get(turnId) ?? '') + delta);
  }

  end(turnId: string): void {
    this.calls.push(`end:${turnId}`);
  }

  interrupt(): void {
    this.calls.push('interrupt');
    this.turnId = undefined;
  }

  /** Morceau de 0,5 s (audible) ou vide, du tour en cours. */
  out(options: { final?: boolean; audible?: boolean } = {}): VoiceAudioOut {
    const chunk: VoiceAudioOut = {
      voiceSessionId: 'v1',
      turnId: this.turnId ?? 'none',
      seq: this.seq,
      sampleRate: 16_000,
      pcm: new Float32Array(options.audible === false ? 0 : 8_000),
      final: options.final ?? false,
    };
    this.seq += 1;
    this.sink.onAudio(chunk);
    return chunk;
  }
}

/** Agent simulé : un tour à la fois, fini par `finish`. */
class FakeAgent implements ConversationAgent {
  readonly sent: string[] = [];
  readonly stopped: string[] = [];
  running = false;
  pending = 0;
  waitPhrase: ((phrase: ToolWaitPhrase) => void) | undefined;
  private idle: (() => void)[] = [];
  private count = 0;

  send(
    _sessionId: string,
    text: string,
    options: { onToolWaitPhrase: (phrase: ToolWaitPhrase) => void },
  ): { turnId: string } {
    if (this.running) throw new AtelierError('agent/busy', 'Un tour est déjà en cours.');
    this.count += 1;
    this.sent.push(text);
    this.running = true;
    this.waitPhrase = options.onToolWaitPhrase;
    return { turnId: `t${String(this.count)}` };
  }

  stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    return Promise.resolve();
  }

  isRunning(): boolean {
    return this.running;
  }

  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  pendingPermissions(): number {
    return this.pending;
  }

  /** Fin réelle du tour (après `done`) : la conversation est de nouveau libre. */
  finish(): void {
    this.running = false;
    const waiting = this.idle;
    this.idle = [];
    for (const resolve of waiting) resolve();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup() {
  const clock = new FakeClock();
  const listener = new FakeListener();
  const speech = new FakeSpeech();
  const agent = new FakeAgent();
  const events: { channel: IpcEventChannel; payload: unknown }[] = [];
  const ends: ConversationEndReason[] = [];
  const conversation = new VoiceConversation({
    voiceSessionId: 'v1',
    sessionId: SESSION,
    endOfTurnSilenceMs: 700,
    listener,
    createSpeech: (sink) => {
      speech.sink = sink;
      return speech;
    },
    agent,
    emit: (channel, payload) => events.push({ channel, payload }),
    onEnd: (reason) => ends.push(reason),
    timers: clock,
  });
  const states = (): VoiceSessionState[] =>
    events.flatMap((e) =>
      e.channel === 'voice:state' ? [(e.payload as { state: VoiceSessionState }).state] : [],
    );
  const state = (): VoiceSessionState | undefined => states().at(-1);
  const audioOut = (): VoiceAudioOut[] =>
    events.flatMap((e) => (e.channel === 'voice:audio-out' ? [e.payload as VoiceAudioOut] : []));
  /** L'utilisateur dit `text` : trames, puis fin de tour du worker. */
  const say = async (text: string): Promise<void> => {
    const id = listener.current;
    if (id === undefined) throw new Error('aucune écoute ouverte');
    conversation.audio(0, frame());
    listener.nextText = text;
    conversation.turnEnded(id);
    await flush();
  };
  const event = (e: Record<string, unknown> & { type: AgentEvent['type'] }): void => {
    conversation.agentEvent({ sessionId: SESSION, turnId: 't1', ...e } as AgentEvent);
  };
  return {
    clock,
    listener,
    speech,
    agent,
    events,
    ends,
    conversation,
    states,
    state,
    audioOut,
    say,
    event,
  };
}

describe('isStopCommand', () => {
  it('reconnaît « stop », « arrête » et « annule » dits seuls', () => {
    for (const text of ['Stop.', 'stop', 'Arrête !', 'arrete', 'Annule.', '  ANNULE  ']) {
      expect(isStopCommand(text)).toBe(true);
    }
    for (const text of [
      'Arrête la musique.',
      'Stop, attends.',
      'Annule le rendez-vous',
      'Bonjour',
    ]) {
      expect(isStopCommand(text)).toBe(false);
    }
  });
});

describe('VoiceConversation', () => {
  it('mène un tour complet : écoute, envoi, voix, garde d’écho, écoute', async () => {
    const h = setup();
    h.conversation.begin();
    expect(h.state()).toBe('starting');
    expect(h.listener.started).toEqual(['v1#1']);
    expect(h.listener.options[0]?.endOfTurnSilenceMs).toBe(700);

    await h.say('Quelle heure est-il ?');
    expect(h.agent.sent).toEqual(['Quelle heure est-il ?']);
    expect(h.state()).toBe('thinking');
    // Pendant le travail silencieux, le micro écoute toujours (file, « stop »).
    expect(h.listener.current).toBe('v1#2');

    h.event({ type: 'text_delta', delta: 'Il est ' });
    h.event({ type: 'text_delta', delta: 'quinze heures.' });
    expect(h.speech.calls).toEqual(['begin:t1', 'push:Il est ', 'push:quinze heures.']);
    h.speech.out();
    expect(h.state()).toBe('speaking');
    expect(h.audioOut()).toHaveLength(1);

    h.event({ type: 'done', reason: 'stop' });
    expect(h.speech.calls.at(-1)).toBe('end:t1');
    const last = h.speech.out({ final: true });
    h.agent.finish();
    await flush();
    expect(h.state()).toBe('speaking');

    h.conversation.playbackEnded('t1', last.seq);
    expect(h.state()).toBe('speaking'); // garde d'écho
    h.clock.advance(VOICE_ECHO_GUARD_MS);
    expect(h.state()).toBe('listening');
    expect(h.listener.current).toBe('v1#3');
    expect(h.states()).toEqual(['starting', 'listening', 'thinking', 'speaking', 'listening']);
  });

  it('ignore le micro pendant la voix de l’agent et pendant la garde d’écho', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Bonjour');
    h.event({ type: 'text_delta', delta: 'Bonjour.' });
    h.speech.out();
    // La session d'écoute est fermée dès que l'agent parle.
    expect(h.listener.cancelled).toEqual(['v1#2']);
    const before = h.listener.audioFor.length;
    h.conversation.audio(1, frame());
    h.event({ type: 'done', reason: 'stop' });
    const last = h.speech.out({ final: true });
    h.agent.finish();
    await flush();
    h.conversation.audio(2, frame());
    h.conversation.playbackEnded('t1', last.seq);
    h.clock.advance(VOICE_ECHO_GUARD_MS - 1);
    h.conversation.audio(3, frame());
    expect(h.listener.audioFor).toHaveLength(before);
    expect(h.listener.current).toBeUndefined();

    h.clock.advance(1);
    await flush(); // la nouvelle session d'écoute démarre
    h.conversation.audio(4, frame());
    expect(h.listener.audioFor.slice(before)).toEqual(['v1#3']);
  });

  it('ignore une fin de lecture d’un ancien morceau, et finit seule sans signal du renderer', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Bonjour');
    h.event({ type: 'text_delta', delta: 'Bonjour.' });
    const first = h.speech.out();
    h.event({ type: 'done', reason: 'stop' });
    h.speech.out({ final: true });
    h.agent.finish();
    await flush();
    h.conversation.playbackEnded('t1', first.seq);
    h.conversation.playbackEnded('autre', 99);
    expect(h.state()).toBe('speaking');
    // 1 s d'audio, puis 5 s de marge : la lecture est tenue pour finie.
    h.clock.advance(6_000);
    h.clock.advance(VOICE_ECHO_GUARD_MS);
    expect(h.state()).toBe('listening');
  });

  it('interrompt : voix coupée, tour arrêté, garde d’écho, puis écoute', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Raconte-moi une histoire');
    h.event({ type: 'text_delta', delta: 'Il était une fois, ' });
    h.speech.out();
    expect(h.state()).toBe('speaking');

    h.conversation.interrupt();
    expect(h.speech.calls.at(-1)).toBe('interrupt');
    expect(h.agent.stopped).toEqual([SESSION]);
    // Le texte qui arrive encore n'est plus prononcé.
    h.event({ type: 'text_delta', delta: 'un roi.' });
    expect(h.speech.calls.at(-1)).toBe('interrupt');
    h.event({ type: 'done', reason: 'aborted' });
    h.agent.finish();
    await flush();
    expect(h.state()).toBe('speaking');
    h.clock.advance(VOICE_ECHO_GUARD_MS);
    expect(h.state()).toBe('listening');
    expect(h.listener.current).toBeDefined();
  });

  it('sans voix ni tour, l’interruption est sans effet', () => {
    const h = setup();
    h.conversation.begin();
    h.conversation.interrupt();
    expect(h.speech.calls).toEqual([]);
    expect(h.agent.stopped).toEqual([]);
  });

  it('met en file une phrase dite pendant un outil et l’envoie à la fin du tour', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Lis le fichier des ventes');
    h.event({ type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', input: {} });
    expect(h.state()).toBe('thinking');

    await h.say('Et celles d’avril aussi');
    expect(h.agent.sent).toEqual(['Lis le fichier des ventes']);

    h.event({ type: 'done', reason: 'stop' });
    h.agent.finish();
    await flush();
    expect(h.agent.sent).toEqual(['Lis le fichier des ventes', 'Et celles d’avril aussi']);
    expect(h.state()).toBe('thinking');
  });

  it('attend la fin de la voix avant d’envoyer la phrase mise en file', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Lis le fichier');
    await h.say('Et résume-le');
    h.event({ type: 'text_delta', delta: 'C’est fait.' });
    h.speech.out();
    h.event({ type: 'done', reason: 'stop' });
    const last = h.speech.out({ final: true });
    h.agent.finish();
    await flush();
    expect(h.agent.sent).toHaveLength(1);
    h.conversation.playbackEnded('t1', last.seq);
    expect(h.agent.sent).toEqual(['Lis le fichier', 'Et résume-le']);
  });

  it('« stop » dit seul arrête le tour en silence, sans être envoyé', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Cherche les factures');
    h.event({ type: 'tool_start', toolCallId: 'c1', toolName: 'web_search', input: {} });
    await h.say('Stop.');
    expect(h.agent.stopped).toEqual([SESSION]);
    expect(h.agent.sent).toEqual(['Cherche les factures']);

    // Sans tour en cours, « arrête » n'est pas envoyé non plus.
    h.event({ type: 'done', reason: 'aborted' });
    h.agent.finish();
    await flush();
    await h.say('Arrête !');
    expect(h.agent.sent).toEqual(['Cherche les factures']);
    expect(h.agent.stopped).toEqual([SESSION]);
  });

  it('pendant une permission : annonce, écoute suspendue, reprise après la réponse à l’écran', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Supprime le brouillon');
    const request = { id: 'p1', sessionId: SESSION } as PermissionRequest;
    h.agent.pending = 1;
    h.event({ type: 'permission_request', request });
    expect(h.speech.texts.get('t1')).toBe(PERMISSION_PHRASE);
    expect(h.listener.current).toBeUndefined();

    h.speech.out();
    expect(h.state()).toBe('speaking');
    const last = h.speech.out({ final: true });
    h.conversation.playbackEnded('t1', last.seq);
    h.clock.advance(VOICE_ECHO_GUARD_MS);
    expect(h.state()).toBe('waiting_permission');
    // Rien de ce qui est dit n'est écouté : aucune permission ne se donne à la voix.
    const before = h.listener.audioFor.length;
    h.conversation.audio(5, frame());
    expect(h.listener.audioFor).toHaveLength(before);
    expect(h.listener.current).toBeUndefined();

    h.agent.pending = 0;
    h.conversation.permissionSettled(request);
    expect(h.state()).toBe('thinking');
    expect(h.listener.current).toBeDefined();
  });

  it('prononce la phrase d’attente d’un outil long, sauf si l’agent parle déjà', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Lis ventes.csv');
    h.agent.waitPhrase?.({ toolCallId: 'c1', toolName: 'read_file', text: 'Je lis ventes.csv.' });
    expect(h.speech.calls).toEqual(['begin:t1', 'push:Je lis ventes.csv.', 'end:t1']);
    h.speech.out();
    h.agent.waitPhrase?.({ toolCallId: 'c2', toolName: 'grep', text: 'Je cherche.' });
    expect(h.speech.calls).toHaveLength(3);
  });

  it('joue l’annonce de permission après le texte en cours, sans le couper', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Écris le rapport');
    h.event({ type: 'text_delta', delta: 'Je prépare le rapport.' });
    h.speech.out();
    h.event({ type: 'permission_request', request: { id: 'p1', sessionId: SESSION } });
    expect(h.speech.calls).toEqual(['begin:t1', 'push:Je prépare le rapport.', 'end:t1']);
    h.speech.out({ final: true });
    expect(h.speech.calls.slice(3)).toEqual(['begin:t1', `push:${PERMISSION_PHRASE}`, 'end:t1']);
  });

  it('se termine après 60 s sans parole pendant l’écoute', async () => {
    const h = setup();
    h.conversation.begin();
    await flush();
    h.conversation.audio(0, frame());
    h.clock.advance(VOICE_CONVERSATION_IDLE_MS - 1);
    expect(h.ends).toEqual([]);
    h.clock.advance(1);
    expect(h.ends).toEqual(['idle']);
    expect(h.state()).toBe('idle');
    expect(h.listener.cancelled).toEqual(['v1#1']);
    // Plus rien n'est relayé ensuite.
    h.conversation.audio(1, frame());
    expect(h.listener.audioFor).toEqual(['v1#1']);
  });

  it('la parole repousse la fin, et le temps de travail de l’agent ne compte pas', async () => {
    const h = setup();
    h.conversation.begin();
    h.clock.advance(50_000);
    h.conversation.speechStarted('v1#1');
    h.clock.advance(50_000);
    expect(h.ends).toEqual([]);
    await h.say('Analyse le dossier');
    h.clock.advance(5 * 60_000);
    expect(h.ends).toEqual([]);
    h.event({ type: 'done', reason: 'stop' });
    h.agent.finish();
    await flush();
    h.clock.advance(VOICE_CONVERSATION_IDLE_MS);
    expect(h.ends).toEqual(['idle']);
  });

  it('relaie les segments sous l’identifiant public, numérotés sur toute la session', async () => {
    const h = setup();
    h.conversation.begin();
    const segment = { index: 0, text: 'Bonjour', final: true, startMs: 0, endMs: 500 };
    h.conversation.transcript({ ...segment, voiceSessionId: 'v1#1' });
    await h.say('Bonjour');
    h.event({ type: 'done', reason: 'stop' });
    h.agent.finish();
    await flush();
    h.conversation.transcript({ ...segment, voiceSessionId: h.listener.current ?? '' });
    h.conversation.transcript({ ...segment, voiceSessionId: 'v1#1' }); // session close : ignoré
    const relayed = h.events.filter((e) => e.channel === 'voice:transcript').map((e) => e.payload);
    expect(relayed).toEqual([
      { ...segment, voiceSessionId: 'v1', index: 0 },
      { ...segment, voiceSessionId: 'v1', index: 1 },
    ]);
  });

  it('ignore un tour vide, et met en file une phrase quand un message tapé occupe l’agent', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('   ');
    expect(h.agent.sent).toEqual([]);

    // Message tapé dans la même conversation : tour étranger, sans voix.
    h.agent.running = true;
    h.conversation.agentEvent({
      sessionId: SESSION,
      turnId: 'typed',
      type: 'text_delta',
      delta: 'Réponse écrite',
    });
    expect(h.state()).toBe('thinking');
    expect(h.speech.calls).toEqual([]);
    await h.say('Et en vocal ?');
    expect(h.agent.sent).toEqual([]);
    h.agent.finish();
    await flush();
    expect(h.agent.sent).toEqual(['Et en vocal ?']);
  });

  it('termine le mode si l’écoute échoue, et ne relaie plus rien après la fin', async () => {
    const h = setup();
    h.conversation.begin();
    h.conversation.listenFailed('v1#1', new AtelierError('voice/engine_failed', 'x'));
    expect(h.ends).toEqual(['error']);
    expect(h.state()).toBe('idle');
    h.conversation.end();
    expect(h.states().filter((s) => s === 'idle')).toHaveLength(1);
    await flush();
  });

  it('la fin demandée coupe la voix sans arrêter le tour de l’agent', async () => {
    const h = setup();
    h.conversation.begin();
    await h.say('Résume le dossier');
    h.event({ type: 'text_delta', delta: 'Voici.' });
    h.speech.out();
    h.conversation.end();
    expect(h.speech.calls.at(-1)).toBe('interrupt');
    expect(h.agent.stopped).toEqual([]);
    expect(h.state()).toBe('idle');
    expect(h.ends).toEqual([]);
    const count = h.audioOut().length;
    h.speech.out({ final: true });
    expect(h.audioOut()).toHaveLength(count);
  });
});
