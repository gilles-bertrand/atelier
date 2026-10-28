import { useEffect, useRef, type ReactNode } from 'react';
import { Card } from '@renderer/components/ui/primitives';

/**
 * Cadre d'une étape. Le titre reçoit le focus à l'affichage : un lecteur
 * d'écran annonce la nouvelle étape et le clavier repart du haut.
 */
export function StepCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <Card aria-labelledby="onboarding-step-title" className="space-y-6 p-6">
      <div className="space-y-1.5">
        <h2
          id="onboarding-step-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          {title}
        </h2>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      <div className="space-y-5">{children}</div>
      <div className="flex items-center justify-between gap-3 border-t pt-4">{footer}</div>
    </Card>
  );
}
