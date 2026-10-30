/**
 * Tuile d'un fichier : icône et teinte de sa famille (tableur, PDF, image…),
 * extension en capitales sur la grande taille. Décorative : le nom du fichier
 * est toujours écrit à côté.
 */
import { FILE_ICONS, FILE_TILE_CLASSES, fileType } from '@renderer/lib/file-types';
import { cn } from '@renderer/lib/utils';

export function FileTypeIcon({
  name,
  mimeType,
  size = 'md',
  className,
}: {
  name: string;
  mimeType?: string | undefined;
  /** `md` : carte de fichier (avec l'extension) ; `sm` : puce, suggestion. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const type = fileType(name, mimeType);
  const Icon = FILE_ICONS[type.kind];
  return (
    <span
      aria-hidden
      data-kind={type.kind}
      className={cn(
        'flex shrink-0 flex-col items-center justify-center rounded-md',
        size === 'md' ? 'h-10 w-9 gap-0.5' : 'size-7',
        FILE_TILE_CLASSES[type.kind],
        className,
      )}
    >
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} />
      {size === 'md' && type.label ? (
        <span className="text-[0.55rem] font-bold leading-none tracking-wide">{type.label}</span>
      ) : null}
    </span>
  );
}
