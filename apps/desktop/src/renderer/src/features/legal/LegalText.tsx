import { Markdown } from '@renderer/features/chat/Markdown';
import { cn } from '@renderer/lib/utils';

/** Texte légal long, dans un cadre défilant et focalisable au clavier. */
export function LegalText({
  text,
  label,
  plain = false,
  className,
}: {
  text: string;
  label: string;
  /** Texte brut (licence en anglais) : police à chasse fixe, sans markdown. */
  plain?: boolean;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'max-h-80 overflow-y-auto rounded-lg border bg-muted/20 px-4 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {plain ? (
        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{text}</pre>
      ) : (
        <Markdown text={text} />
      )}
    </div>
  );
}
