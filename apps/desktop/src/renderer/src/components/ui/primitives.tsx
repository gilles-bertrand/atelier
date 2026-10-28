/**
 * Primitives d'interface (style shadcn/ui « new-york », palette neutral) :
 * champs, libellés, cartes, alertes, barre de progression.
 */
import type { ComponentProps, ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // `htmlFor` est fourni par l'appelant.
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

/** Texte d'aide sous un champ. */
export function Hint({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  );
}

type Tone = 'info' | 'success' | 'warning' | 'error';

const TONE_STYLES: Record<Tone, string> = {
  info: 'border-border bg-muted/40 text-foreground',
  success:
    'border-emerald-600/30 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
  warning:
    'border-amber-600/30 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100',
  error: 'border-destructive/40 bg-destructive/5 text-destructive',
};

const TONE_ICONS: Record<Tone, ReactNode> = {
  info: <Info className="size-4 shrink-0" aria-hidden />,
  success: <CheckCircle2 className="size-4 shrink-0" aria-hidden />,
  warning: <TriangleAlert className="size-4 shrink-0" aria-hidden />,
  error: <AlertCircle className="size-4 shrink-0" aria-hidden />,
};

/** Message encadré. `error` et `warning` sont annoncés aux lecteurs d'écran. */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', TONE_STYLES[tone], className)}
    >
      <span className="mt-0.5">{TONE_ICONS[tone]}</span>
      <div className="space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="leading-relaxed">{children}</div> : null}
      </div>
    </div>
  );
}

/** Barre de progression accessible ; indéterminée si `value` est absent. */
export function Progress({ value, label }: { value?: number | undefined; label: string }) {
  const percent =
    value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-500',
          percent === undefined && 'w-1/3 animate-pulse',
        )}
        style={percent !== undefined ? { width: `${String(percent)}%` } : undefined}
      />
    </div>
  );
}
