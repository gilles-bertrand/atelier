/**
 * Pied de la colonne de gauche : ligne d'état de l'environnement (machine
 * isolée, serveur), dépliable pour voir le modèle et l'interrupteur Internet
 * des commandes de la conversation ouverte.
 */
import { useId, useState } from 'react';
import { ChevronUp, Cpu, Globe, RotateCw, Server } from 'lucide-react';
import type { SandboxStatus, ServerStatus, SessionSummary } from '@atelier/shared';
import { serverStatusText } from '@renderer/components/status/ServerStatusBadge';
import { StatusDot, type StatusTone } from '@renderer/components/status/StatusDot';
import { Button } from '@renderer/components/ui/button';
import { Switch } from '@renderer/components/ui/primitives';
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

export const VM_TONES: Record<SandboxStatus['state'], StatusTone> = {
  absent: 'idle',
  stopped: 'idle',
  starting: 'busy',
  provisioning: 'busy',
  ready: 'ok',
  restarting: 'busy',
  error: 'error',
};

function VmDot({ state }: { state: SandboxStatus['state'] }) {
  return <StatusDot tone={VM_TONES[state]} />;
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
  /** Modèle de la conversation ouverte, sinon le modèle par défaut. */
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

  // Arrêtée ou en échec : relance à la demande (même action que l'accueil).
  const [restarting, setRestarting] = useState(false);
  const canRestart = sandbox.state === 'error' || sandbox.state === 'stopped';
  const restart = async (): Promise<void> => {
    setRestarting(true);
    setError(undefined);
    try {
      await call('sandbox:ensure-ready');
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setRestarting(false);
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
            {sandbox.state === 'error' ? (
              <div className="space-y-1 text-xs">
                <p className="text-destructive">La machine isolée n’a pas pu démarrer.</p>
                {sandbox.error ? (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer">Détails techniques</summary>
                    <p className="mt-1 break-words font-mono">{sandbox.error}</p>
                  </details>
                ) : null}
              </div>
            ) : null}
            {canRestart ? (
              <Button
                variant="outline"
                size="sm"
                disabled={restarting}
                onClick={() => void restart()}
                className="w-full"
              >
                <RotateCw
                  className={cn('size-3.5', restarting ? 'animate-spin' : undefined)}
                  aria-hidden
                />
                {restarting ? 'Démarrage…' : 'Redémarrer la machine isolée'}
              </Button>
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
              <dt className="text-muted-foreground">{session ? 'Modèle' : 'Modèle par défaut'}</dt>
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
            <Switch
              id={switchId}
              checked={networkOn}
              aria-describedby={`${switchId}-hint`}
              disabled={busy || sandbox.state !== 'ready' || !mountedHere}
              onCheckedChange={(enabled) => void toggleNetwork(enabled)}
              className="mt-0.5"
            />
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
