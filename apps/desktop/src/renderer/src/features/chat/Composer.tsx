/**
 * Zone de saisie : texte, pièces jointes en attente (vignettes pour les images),
 * envoi (Entrée) ou arrêt du tour en cours.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, FileText, Square, X } from 'lucide-react';
import type { Attachment } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { formatBytes } from '@renderer/lib/format';

export interface PendingAttachment {
  attachment: Attachment;
  /** URL `blob:` de vignette (images déposées), à révoquer. */
  previewUrl?: string;
}

export function Composer({
  value,
  onChange,
  attachments,
  onRemoveAttachment,
  onSend,
  onStop,
  running,
  disabled,
  importing,
  status,
}: {
  value: string;
  onChange: (value: string) => void;
  attachments: readonly PendingAttachment[];
  onRemoveAttachment: (index: number) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  importing: boolean;
  /** Indicateur à gauche du bouton d'envoi (jauge de contexte). */
  status?: ReactNode;
}) {
  const inputId = useId();
  const hintId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const canSend =
    !running && !disabled && !importing && (value.trim() !== '' || attachments.length > 0);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="border-t bg-background px-6 pb-5 pt-3">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-xl border bg-card shadow-xs focus-within:ring-2 focus-within:ring-ring">
          {attachments.length > 0 ? (
            <ul aria-label="Pièces jointes" className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((pending, index) => (
                <li
                  key={pending.attachment.path}
                  className="flex items-center gap-2 rounded-lg border bg-background py-1 pl-1 pr-1.5 text-xs"
                >
                  {pending.previewUrl ? (
                    <img src={pending.previewUrl} alt="" className="size-9 rounded object-cover" />
                  ) : (
                    <span className="flex size-9 items-center justify-center rounded bg-muted">
                      <FileText className="size-4 text-muted-foreground" aria-hidden />
                    </span>
                  )}
                  <span className="max-w-40">
                    <span className="block truncate font-medium">{pending.attachment.name}</span>
                    <span className="text-muted-foreground">
                      {formatBytes(pending.attachment.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Retirer ${pending.attachment.name}`}
                    onClick={() => {
                      onRemoveAttachment(index);
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor={inputId} className="sr-only">
            Votre message
          </label>
          <textarea
            id={inputId}
            ref={textarea}
            rows={2}
            value={value}
            disabled={disabled}
            aria-describedby={hintId}
            placeholder="Demandez quelque chose à l’assistant…"
            onChange={(e) => {
              onChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            className="block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground [field-sizing:content] disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <p id={hintId} className="text-xs text-muted-foreground">
              {importing
                ? 'Import des fichiers…'
                : 'Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Glissez des fichiers ici.'}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {status}
              {running ? (
                <Button size="sm" variant="outline" onClick={onStop}>
                  <Square className="size-3.5 fill-current" aria-hidden />
                  Arrêter
                </Button>
              ) : (
                <Button size="sm" onClick={onSend} disabled={!canSend}>
                  <ArrowUp className="size-4" aria-hidden />
                  Envoyer
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
