/**
 * Poignée de redimensionnement du panneau d'aperçu (bord gauche) : glisser à la
 * souris ou au trackpad, flèches gauche / droite au clavier, double-clic pour
 * revenir à la largeur par défaut. La largeur est mémorisée (localStorage).
 */
import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { readStored, writeStored } from '../sidebar/useSidebarState';

export const PREVIEW_WIDTH_KEY = 'atelier.preview.width';
/** Largeur minimale du panneau d'aperçu (px). */
export const MIN_PREVIEW_WIDTH = 320;
/** Largeur minimale laissée à la conversation (px). */
export const MIN_CHAT_WIDTH = 360;
/** Pas du clavier (px). */
const KEY_STEP = 24;

/** Borne une largeur entre le minimum du panneau et ce que la conversation laisse. */
export function clampWidth(width: number, available: number): number {
  const max = Math.max(MIN_PREVIEW_WIDTH, available - MIN_CHAT_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_PREVIEW_WIDTH), max));
}

function readWidth(): number | undefined {
  const value = Number(readStored(PREVIEW_WIDTH_KEY));
  return Number.isFinite(value) && value >= MIN_PREVIEW_WIDTH ? value : undefined;
}

/** Largeur choisie par l'utilisateur (`undefined` : largeur par défaut, relative à la fenêtre). */
export function usePreviewWidth(): {
  width: number | undefined;
  setWidth: (width: number | undefined) => void;
} {
  const [width, setState] = useState(readWidth);
  const setWidth = useCallback((next: number | undefined) => {
    setState(next);
    writeStored(PREVIEW_WIDTH_KEY, next === undefined ? '' : String(next));
  }, []);
  return { width, setWidth };
}

export function ResizeHandle({
  panel,
  width,
  onResize,
  onDragChange,
  controls,
}: {
  /** Panneau redimensionné (sa largeur réelle et celle de son conteneur font foi). */
  panel: React.RefObject<HTMLElement | null>;
  width: number | undefined;
  onResize: (width: number | undefined) => void;
  /** Vrai pendant un glissement (l'aperçu coupe alors les événements de ses iframes). */
  onDragChange: (dragging: boolean) => void;
  controls: string;
}) {
  const measure = (): { current: number; right: number; available: number } | undefined => {
    const element = panel.current;
    const container = element?.parentElement;
    if (!element || !container) return undefined;
    const box = container.getBoundingClientRect();
    return {
      current: element.getBoundingClientRect().width,
      right: box.right,
      available: box.width,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragChange(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = measure();
    if (box) onResize(clampWidth(box.right - event.clientX, box.available));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragChange(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const box = measure();
    if (!box) return;
    // Poignée à gauche du panneau : vers la gauche, le panneau s'élargit.
    const delta = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    onResize(clampWidth(box.current + delta, box.available));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionner l’aperçu"
      aria-controls={controls}
      aria-valuemin={MIN_PREVIEW_WIDTH}
      aria-valuenow={width !== undefined ? width : undefined}
      tabIndex={0}
      title="Glisser pour redimensionner (double-clic : largeur par défaut)"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={() => {
        onDragChange(false);
      }}
      onDoubleClick={() => {
        onResize(undefined);
      }}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-0.5 group-hover:bg-brand/60 group-focus-visible:w-0.5 group-focus-visible:bg-brand"
      />
    </div>
  );
}
