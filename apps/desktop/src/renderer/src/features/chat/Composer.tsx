/**
 * Zone de saisie : texte, pièces jointes en attente (vignettes pour les images,
 * tuile typée pour les autres), trombone pour joindre sans glisser-déposer,
 * envoi (Entrée) ou arrêt du tour en cours.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import type { Attachment } from '@atelier/shared';
import { FileTypeIcon } from '@renderer/components/FileTypeIcon';
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
  notice,
  footer,
  onAddFiles,
  textareaRef,
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
  /** Indicateurs à gauche du bouton d'envoi (choix du modèle, jauge de contexte). */
  status?: ReactNode;
  /** Avertissement dans la saisie, sous les pièces jointes (image illisible…). */
  notice?: ReactNode;
  /** Avertissement non bloquant sous la saisie (modèle à froid…). */
  footer?: ReactNode;
  /** Fichiers choisis avec le trombone (même import que le glisser-déposer). */
  onAddFiles?: (files: File[]) => void;
  /** Champ de saisie, pour y placer le curseur depuis la vue (suggestions). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const inputId = useId();
  const hintId = useId();
  const ownTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? ownTextarea;
  const fileInput = useRef<HTMLInputElement>(null);
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
                    <FileTypeIcon
                      name={pending.attachment.name}
                      mimeType={pending.attachment.mimeType}
                      className="h-9"
                    />
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
          {notice ? <div className="px-3 pt-3">{notice}</div> : null}
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
            {onAddFiles ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Joindre des fichiers"
                  title="Joindre des fichiers (ou glissez-les dans la conversation)"
                  disabled={disabled || importing}
                  onClick={() => fileInput.current?.click()}
                  className="size-8 shrink-0 text-muted-foreground"
                >
                  <Paperclip className="size-4" aria-hidden />
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    // Rechoisir le même fichier doit redéclencher l'import.
                    e.target.value = '';
                    if (files.length > 0) onAddFiles(files);
                  }}
                />
              </>
            ) : null}
            <p id={hintId} className="min-w-0 flex-1 text-xs text-muted-foreground">
              {importing
                ? 'Import des fichiers…'
                : onAddFiles
                  ? 'Entrée pour envoyer, Maj + Entrée pour aller à la ligne.'
                  : 'Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Glissez des fichiers ici.'}
            </p>
            <div className="flex shrink-0 items-center gap-1">
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
        {footer ? <div className="pt-2">{footer}</div> : null}
      </div>
    </div>
  );
}
