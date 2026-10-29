/**
 * Fil de la conversation : messages, message en direct et état du tour
 * (réflexion, reconnexion, erreur avec « Réessayer »).
 */
import { useEffect, useRef } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { canRetry, errorMessage } from '@renderer/lib/error-messages';
import type { SessionView, TurnView } from '@renderer/state/chat-reducer';
import { Markdown } from './Markdown';
import { AttachmentChip, ReasoningBlock, SourcesBadge, ToolCallBlock } from './MessageParts';

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-2 rounded-2xl bg-secondary px-4 py-2.5 text-sm">
        <h3 className="sr-only">Vous</h3>
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                {part.text}
              </p>
            );
          }
          if (part.type === 'attachment') {
            return (
              <div key={i}>
                <AttachmentChip attachment={part.attachment} />
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

export function AssistantMessage({ message, live }: { message: ChatMessage; live: boolean }) {
  return (
    <div className="space-y-3">
      <h3 className="sr-only">Assistant</h3>
      {message.parts.map((part, i) => {
        const key = part.type === 'tool_call' ? part.toolCallId : `${part.type}-${String(i)}`;
        switch (part.type) {
          case 'text':
            return <Markdown key={key} text={part.text} />;
          case 'reasoning':
            return (
              <ReasoningBlock
                key={key}
                text={part.text}
                live={live && i === message.parts.length - 1}
              />
            );
          case 'tool_call':
            return <ToolCallBlock key={key} part={part} />;
          case 'sources':
            return <SourcesBadge key={key} sources={part.sources} />;
          case 'attachment':
            return <AttachmentChip key={key} attachment={part.attachment} />;
        }
      })}
    </div>
  );
}

function TurnStatus({
  turn,
  hasLiveContent,
  onRetry,
}: {
  turn: TurnView | undefined;
  hasLiveContent: boolean;
  onRetry: () => void;
}) {
  if (!turn) return null;
  if (turn.status === 'running') {
    if (turn.retry) {
      return (
        <p
          className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reconnexion au serveur…
          {turn.retry.maxAttempts !== undefined
            ? ` (tentative ${String(turn.retry.attempt)}/${String(turn.retry.maxAttempts)})`
            : ''}
        </p>
      );
    }
    return hasLiveContent ? null : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        L’assistant réfléchit…
      </p>
    );
  }
  if (turn.status === 'error' && turn.error) {
    return (
      <div className="space-y-2">
        <Alert tone="error" title="La réponse n’a pas pu aboutir">
          {errorMessage(turn.error)}
        </Alert>
        {canRetry(turn.error) ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" aria-hidden />
            Réessayer
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Reformulez votre demande ci-dessous.</p>
        )}
      </div>
    );
  }
  if (turn.status === 'aborted') {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
        Arrêté.
        <Button variant="ghost" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
          Reprendre
        </Button>
      </div>
    );
  }
  if (turn.stopReason === 'max_steps') {
    return (
      <Alert tone="warning">
        L’assistant s’est arrêté après de nombreuses étapes. Demandez-lui de continuer si besoin.
      </Alert>
    );
  }
  if (turn.stopReason === 'length') {
    return <Alert tone="warning">La réponse a été coupée car elle était trop longue.</Alert>;
  }
  return null;
}

export function MessageList({ view, onRetry }: { view: SessionView; onRetry: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const liveSize = view.live?.parts.reduce(
    (n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? p.text.length : 1),
    0,
  );

  // Suit le flux tant que l'utilisateur est en bas de la conversation.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [view.messages.length, liveSize, view.turn?.status]);

  return (
    <div ref={container} className="flex-1 overflow-y-auto">
      <div
        role="log"
        aria-label="Conversation"
        className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6"
      >
        {view.messages.map((message) =>
          message.role === 'user' ? (
            <UserMessage key={message.id} message={message} />
          ) : (
            <AssistantMessage key={message.id} message={message} live={false} />
          ),
        )}
        {view.live && view.live.parts.length > 0 ? (
          <AssistantMessage message={view.live} live />
        ) : null}
        {view.turn?.compacted ? (
          <p className="text-center text-xs text-muted-foreground">
            Les messages les plus anciens ont été résumés pour tenir dans la mémoire du modèle.
          </p>
        ) : null}
        <TurnStatus
          turn={view.turn}
          hasLiveContent={(view.live?.parts.length ?? 0) > 0}
          onRetry={onRetry}
        />
      </div>
      {/* Annonce discrète de fin de réponse pour les lecteurs d'écran. */}
      <p className="sr-only" aria-live="polite">
        {view.turn?.status === 'done' ? 'Réponse terminée.' : ''}
      </p>
    </div>
  );
}
