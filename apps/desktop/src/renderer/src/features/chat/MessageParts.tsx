/**
 * Parties d'un message : texte (markdown), réflexion repliée, bloc d'outil
 * repliable, pièce jointe, badge « Sources ».
 */
import { useId, useState } from 'react';
import {
  Ban,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileText,
  ImageIcon,
  Link2,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { Attachment, ToolCallPart, WebSearchResult } from '@atelier/shared';
import { formatBytes } from '@renderer/lib/format';
import { toolLabel } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { isProminentDisplay, ToolDisplayView, WebLink } from './ToolDisplays';

const STATUS: Record<
  ToolCallPart['status'],
  { label: string; icon: typeof Loader2; className: string }
> = {
  running: { label: 'en cours', icon: Loader2, className: 'animate-spin text-muted-foreground' },
  success: { label: 'terminé', icon: CheckCircle2, className: 'text-emerald-600' },
  error: { label: 'échec', icon: XCircle, className: 'text-destructive' },
  denied: { label: 'refusé', icon: Ban, className: 'text-amber-600' },
};

function inputPreview(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Bloc d'outil : titre lisible et statut ; détails (entrée, sortie) repliés. */
export function ToolCallBlock({ part }: { part: ToolCallPart }) {
  const status = STATUS[part.status];
  const Icon = status.icon;
  const label = toolLabel(part.toolName, part.input);
  const prominent = part.display && isProminentDisplay(part.display) ? part.display : undefined;
  return (
    <div className="space-y-2">
      <details className="group rounded-lg border bg-muted/30 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Icon className={cn('size-4 shrink-0', status.className)} aria-hidden />
          <span className="sr-only">({status.label})</span>
        </summary>
        <div className="space-y-3 border-t px-3 py-3">
          {part.display && !prominent ? <ToolDisplayView display={part.display} /> : null}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Paramètres</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {inputPreview(part.input)}
            </pre>
          </div>
          {part.output ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Résultat</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {part.output}
              </pre>
            </div>
          ) : null}
        </div>
      </details>
      {prominent ? <ToolDisplayView display={prominent} /> : null}
    </div>
  );
}

/** Réflexion du modèle (mode thinking), repliée par défaut. */
export function ReasoningBlock({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="group text-sm text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Brain className="size-3.5" aria-hidden />
        {live ? 'Réflexion en cours…' : 'Réflexion'}
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <p className="mt-2 whitespace-pre-wrap border-l-2 pl-3 text-xs leading-relaxed">{text}</p>
    </details>
  );
}

/** Pièce jointe (chip). */
export function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mimeType?.startsWith('image/') ?? false;
  const Icon = isImage ? ImageIcon : FileText;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate" title={attachment.path}>
        {attachment.name}
      </span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
    </span>
  );
}

/** Badge « Sources » : liste repliable des pages consultées. */
export function SourcesBadge({ sources }: { sources: readonly WebSearchResult[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (sources.length === 0) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Link2 className="size-3.5" aria-hidden />
        Sources ({sources.length})
      </button>
      {open ? (
        <ul id={listId} className="space-y-2.5 rounded-lg border bg-card px-3 py-2.5">
          {sources.map((s) => (
            <WebLink key={s.url} result={s} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
