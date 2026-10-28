/**
 * Réduction des `AgentEvent` en messages affichés et persistés.
 *
 * Code pur partagé par le process main (persistance de l'historique) et le
 * renderer (affichage en direct) : les deux construisent exactement le même
 * `ChatMessage` assistant à partir du même flux d'événements.
 */
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  MessagePart,
  SerializedAtelierError,
  TodoItem,
  ToolCallPart,
  WebSearchResult,
} from '@atelier/shared';

/** Crée le message utilisateur d'un tour (texte puis pièces jointes). */
export function createUserMessage(options: {
  id: string;
  sessionId: string;
  text: string;
  attachments?: readonly Attachment[];
  createdAt: string;
}): ChatMessage {
  const parts: MessagePart[] = [];
  if (options.text.trim().length > 0) parts.push({ type: 'text', text: options.text });
  for (const attachment of options.attachments ?? [])
    parts.push({ type: 'attachment', attachment });
  return {
    id: options.id,
    sessionId: options.sessionId,
    role: 'user',
    parts,
    createdAt: options.createdAt,
  };
}

/** Crée un message assistant vide, rempli ensuite par {@link applyAgentEvent}. */
export function createAssistantMessage(options: {
  id: string;
  sessionId: string;
  createdAt: string;
}): ChatMessage {
  return { ...options, role: 'assistant', parts: [] };
}

/**
 * Applique un événement au message assistant du tour. Les événements sans effet
 * sur le contenu (permission, reconnexion, fin…) renvoient le message inchangé.
 * Ne mute jamais l'entrée (compatible avec l'état React).
 */
export function applyAgentEvent(message: ChatMessage, event: AgentEvent): ChatMessage {
  switch (event.type) {
    case 'text_delta':
      return appendDelta(message, 'text', event.delta);
    case 'reasoning_delta':
      return appendDelta(message, 'reasoning', event.delta);
    case 'tool_start': {
      const part: ToolCallPart = {
        type: 'tool_call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: 'running',
      };
      return { ...message, parts: [...message.parts, part] };
    }
    case 'tool_display':
      return updateToolCall(message, event.toolCallId, (part) => ({
        ...part,
        display: event.display,
      }));
    case 'tool_result':
      return updateToolCall(message, event.toolCallId, (part) => {
        const display = event.display ?? part.display;
        return {
          ...part,
          status: event.denied ? 'denied' : event.ok ? 'success' : 'error',
          output: event.output,
          ...(display ? { display } : {}),
        };
      });
    case 'sources':
      return mergeSources(message, event.sources);
    case 'todo_update':
    case 'permission_request':
    case 'llm_retry':
    case 'compaction':
    case 'done':
    case 'error':
      return message;
  }
}

function appendDelta(message: ChatMessage, type: 'text' | 'reasoning', delta: string): ChatMessage {
  if (delta.length === 0) return message;
  const last = message.parts.at(-1);
  if (last?.type === type) {
    const parts = [...message.parts];
    parts[parts.length - 1] = { type, text: last.text + delta };
    return { ...message, parts };
  }
  return { ...message, parts: [...message.parts, { type, text: delta }] };
}

function updateToolCall(
  message: ChatMessage,
  toolCallId: string,
  update: (part: ToolCallPart) => ToolCallPart,
): ChatMessage {
  const index = message.parts.findIndex(
    (part) => part.type === 'tool_call' && part.toolCallId === toolCallId,
  );
  const target = message.parts[index];
  if (target?.type !== 'tool_call') return message;
  const parts = [...message.parts];
  parts[index] = update(target);
  return { ...message, parts };
}

function mergeSources(message: ChatMessage, sources: readonly WebSearchResult[]): ChatMessage {
  const index = message.parts.findIndex((part) => part.type === 'sources');
  const existing = index >= 0 ? message.parts[index] : undefined;
  const merged = dedupeSources([
    ...(existing?.type === 'sources' ? existing.sources : []),
    ...sources,
  ]);
  if (index < 0)
    return { ...message, parts: [...message.parts, { type: 'sources', sources: merged }] };
  const parts = [...message.parts];
  parts[index] = { type: 'sources', sources: merged };
  return { ...message, parts };
}

/** Supprime les doublons d'URL en gardant le premier résultat. */
export function dedupeSources(sources: readonly WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

/**
 * Marque les appels d'outils restés « en cours » comme échoués (tour interrompu
 * ou en erreur) : l'historique persisté ne garde jamais d'outil fantôme.
 */
export function settleRunningTools(message: ChatMessage): ChatMessage {
  if (!message.parts.some((p) => p.type === 'tool_call' && p.status === 'running')) return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'tool_call' && part.status === 'running'
        ? { ...part, status: 'error', output: part.output ?? 'Interrompu.' }
        : part,
    ),
  };
}

/**
 * Dernière liste de tâches non vide de l'historique (reprise de session, panneau
 * latéral). Une liste vidée en fin de tâche par le modèle n'efface pas l'affichage.
 */
export function latestTodos(messages: readonly ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part?.type === 'tool_call' && part.display?.type === 'todos') {
        if (part.display.todos.length > 0) return part.display.todos;
      }
    }
  }
  return [];
}

/** Titre de session dérivé du premier message (60 caractères max). */
export function deriveSessionTitle(text: string, fallback = 'Nouvelle conversation'): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return fallback;
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

/** Texte envoyé au modèle pour un message utilisateur (même format qu'à la reprise). */
export function userModelText(text: string, attachments: readonly Attachment[] = []): string {
  const lines = [text, ...attachments.map((a) => `[Pièce jointe : ${a.path}]`)];
  return lines.filter((l) => l.trim().length > 0).join('\n\n');
}

/** Erreur d'un tour, telle que gardée côté UI. */
export type TurnError = SerializedAtelierError;
