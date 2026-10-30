import { TriangleAlert } from 'lucide-react';
import { useApp } from '@renderer/state/app-state';

/**
 * Bandeau affiché quand la base d'historique est inutilisable : les
 * conversations restent en mémoire et seront perdues à la fermeture.
 */
export function HistoryBanner() {
  const { state } = useApp();
  if (state.health.historyPersistent) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-warning/40 bg-warning-soft px-4 py-2 text-sm text-warning-text"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong className="font-medium">L’historique ne sera pas conservé.</strong> Atelier n’a pas
        pu ouvrir sa base de conversations : celles d’aujourd’hui seront perdues à la fermeture de
        l’application. Redémarrez Atelier ; si le problème persiste, contactez votre support.
      </p>
    </div>
  );
}
