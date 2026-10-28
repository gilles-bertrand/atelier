/**
 * Historique envoyé au modèle : conversion depuis les messages affichés
 * ({@link ChatMessage}) et retrait du raisonnement « thinking », qui n'est
 * jamais réinjecté.
 */
import type { ModelMessage, ToolResultPart } from 'ai';
import type { ChatMessage } from '@atelier/shared';

/** Retire les parties `reasoning` des messages assistant (et les messages devenus vides). */
export function stripReasoning(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') {
      out.push(msg);
      continue;
    }
    const content = msg.content.filter(
      (p) => p.type !== 'reasoning' && p.type !== 'reasoning-file',
    );
    if (content.length === msg.content.length) out.push(msg);
    else if (content.length > 0) out.push({ ...msg, content });
  }
  return out;
}

/** Vrai si au moins un message assistant contient du raisonnement. */
export function hasReasoning(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      typeof m.content !== 'string' &&
      m.content.some((p) => p.type === 'reasoning' || p.type === 'reasoning-file'),
  );
}

/**
 * Reconstruit l'historique modèle depuis les messages persistés (reprise d'une
 * session). Les appels d'outils terminés redeviennent des paires
 * appel / résultat ; le raisonnement et les sources sont ignorés.
 */
export function chatMessagesToModelMessages(chat: readonly ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of chat) {
    if (message.role === 'user') {
      const texts: string[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') texts.push(part.text);
        if (part.type === 'attachment') {
          texts.push(`[Pièce jointe : ${part.attachment.path}]`);
        }
      }
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') });
      continue;
    }
    // Assistant : on découpe en étapes (texte + appels) suivies de leurs résultats.
    let assistant: Exclude<ModelMessage & { role: 'assistant' }, { content: string }>['content'] =
      [];
    let results: ToolResultPart[] = [];
    const flush = (): void => {
      if (assistant.length > 0) out.push({ role: 'assistant', content: assistant });
      if (results.length > 0) out.push({ role: 'tool', content: results });
      assistant = [];
      results = [];
    };
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (results.length > 0) flush();
        assistant.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_call' && part.status !== 'running') {
        if (results.length > 0) flush();
        assistant.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        results.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: 'text', value: part.output ?? '' },
        });
      }
    }
    flush();
  }
  return out;
}
