/**
 * Marque d'Atelier : l'icône de l'app (orbe de verre vert et deux lames, voir
 * apps/desktop/build/icon.svg) redessinée en SVG pour rester nette à toute taille.
 * Décorative. Ses couleurs sont celles de l'icône, identiques dans les deux thèmes.
 */
import { useId } from 'react';
import { cn } from '@renderer/lib/utils';

export function AtelierMark({ className }: { className?: string }) {
  // Identifiants de dégradés propres à chaque instance (référencés par url(#…)).
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ref = (name: string): string => `url(#${id}-${name})`;
  return (
    <svg viewBox="100 100 824 824" className={cn('shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1C2023" />
          <stop offset="1" stopColor="#0A0B0D" />
        </linearGradient>
        <radialGradient id={`${id}-halo`} cx="0.5" cy="0.53" r="0.42">
          <stop offset="0" stopColor="#5BE38C" stopOpacity="0.3" />
          <stop offset="1" stopColor="#5BE38C" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-blade-l`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#8AF0A8" />
          <stop offset="1" stopColor="#2E9E62" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={`${id}-blade-r`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8AF0A8" />
          <stop offset="1" stopColor="#2E9E62" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={`${id}-orb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9EF5B8" />
          <stop offset="1" stopColor="#2C9A5E" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="186" fill={ref('tile')} />
      <rect x="100" y="100" width="824" height="824" rx="186" fill={ref('halo')} />
      <path
        d="M420 505 C340 470 260 430 168 392 C250 470 330 540 416 585 Z"
        fill={ref('blade-l')}
      />
      <path
        d="M604 505 C684 470 764 430 856 392 C774 470 694 540 608 585 Z"
        fill={ref('blade-r')}
      />
      <circle cx="512" cy="540" r="128" fill={ref('orb')} />
      <path
        d="M408 500 A116 116 0 0 1 616 500"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.6"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <rect
        x="101"
        y="101"
        width="822"
        height="822"
        rx="185"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.1"
        strokeWidth="2"
      />
    </svg>
  );
}
