/**
 * Pied de la colonne de gauche : ligne d'état de l'environnement (machine
 * isolée, serveur), dépliable pour voir le modèle et l'interrupteur Internet
 * des commandes de la conversation ouverte.
 */
import { useId, useState } from 'react';
import { ChevronUp, Cpu, Globe, Loader2, Server } from 'lucide-react';
import type { SandboxStatus, ServerStatus, SessionSummary } from '@atelier/shared';
import { serverStatusText } from '@renderer/components/status/ServerStatusBadge';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { cn } from '@renderer/lib/utils';

export const VM_LABELS: Record<SandboxStatus['state'], string> = {
  absent: 'Pas encore préparé',
  stopped: 'Arrêté',
  starting: 'Démarrage…',
  provisioning: 'Préparation…',
  ready: 'Prêt',
  restarting: 'Changement de dossier…',
  error: 'Indisponible',
};

const VM_DOTS: Record<SandboxStatus['state'], string> = {
  absent: 'bg-muted-foreground/50',
  stopped: 'bg-muted-foreground/50',
  starting: 'bg-amber-500',
  provisioning: 'bg-amber-500',
  ready: 'bg-emerald-500',
  restarting: 'bg-amber-500',
  error: 'bg-red-500',
};

const BUSY_STATES: readonly SandboxStatus['state'][] = ['starting', 'provisioning', 'restarting'];

function VmDot({ state }: { state: SandboxStatus['state'] }) {
  return BUSY_STATES.includes(state) ? (
    <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
  ) : (
    <span className={cn('size-2 rounded-full', VM_DOTS[state])} aria-hidden />
  );
}

export function EnvironmentStatus({
  session,
  sandbox,
  server,
  model,
}: {
  /** Conversation ouverte : l'interrupteur Internet s'applique à elle. */
  session: SessionSummary | undefined;
  sandbox: SandboxStatus;
  server: ServerStatus;
  model: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const switchId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const mountedHere = session !== undefined && sandbox.workspace === session.workspace;
  const networkOn = sandbox.networkEnabled && mountedHere;

  const toggleNetwork = async (enabled: boolean): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      await call('sandbox:set-network', { sessionId: session.id, enabled });
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setBusy(false);
    }
  };

  const hint =
    session === undefined
      ? 'Ouvrez une conversation pour l’autoriser.'
      : 'Coupé par défaut. La recherche web de l’assistant reste disponible.';

  return (
    <section aria-label="Environnement" className="border-t">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          setExpanded((value) => !value);
        }}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Cpu className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Environnement</span>
          <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <VmDot state={sandbox.state} />
            {VM_LABELS[sandbox.state]}
            {networkOn ? ' · Internet autorisé' : null}
          </span>
        </span>
        <ChevronUp
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            expanded ? undefined : 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div id={detailsId} className="space-y-3 px-3 pb-3">
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Machine isolée</dt>
              <dd className="flex items-center gap-2">
                <VmDot state={sandbox.state} />
                {VM_LABELS[sandbox.state]}
              </dd>
            </div>
            {sandbox.state === 'error' && sandbox.error ? (
              <p className="text-xs text-destructive">{sandbox.error}</p>
            ) : null}
            {session !== undefined && sandbox.state === 'ready' && !mountedHere ? (
              <p className="text-xs text-muted-foreground">
                Le dossier de cette conversation sera monté au prochain message.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                <Server className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                Serveur
              </dt>
              <dd className="truncate text-right text-xs">{serverStatusText(server)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Modèle</dt>
              <dd className="truncate font-mono text-xs" title={model}>
                {model}
              </dd>
            </div>
          </dl>

          <div className="flex items-start justify-between gap-3 rounded-lg border px-2.5 py-2">
            <div className="space-y-0.5">
              <label htmlFor={switchId} className="flex items-center gap-1.5 text-sm font-medium">
                <Globe className="size-3.5" aria-hidden />
                Internet pour les commandes
              </label>
              <p id={`${switchId}-hint`} className="text-xs text-muted-foreground">
                {hint}
              </p>
            </div>
            <button
              id={switchId}
              type="button"
              role="switch"
              aria-checked={networkOn}
              aria-describedby={`${switchId}-hint`}
              disabled={busy || sandbox.state !== 'ready' || !mountedHere}
              onClick={() => void toggleNetwork(!networkOn)}
              className={cn(
                'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                networkOn ? 'bg-primary' : 'bg-input',
              )}
            >
              <span
                className={cn(
                  'inline-block size-4 rounded-full bg-background shadow transition-transform',
                  networkOn ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
