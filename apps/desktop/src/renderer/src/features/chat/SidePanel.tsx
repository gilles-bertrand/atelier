/**
 * Panneau latéral de la conversation : tâches en direct, fichiers créés ou
 * modifiés, état de l'environnement d'exécution (VM, réseau) et du serveur.
 */
import { useId, useState, type ReactNode } from 'react';
import { Cpu, FileText, Globe, ListChecks, Loader2, Server } from 'lucide-react';
import type {
  ChatMessage,
  FileCard as FileCardData,
  SandboxStatus,
  ServerStatus,
  SessionSummary,
} from '@atelier/shared';
import { serverStatusText } from '@renderer/components/status/ServerStatusBadge';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { cn } from '@renderer/lib/utils';
import type { SessionView } from '@renderer/state/chat-reducer';
import { FileCard, TodoList } from './ToolDisplays';

/**
 * Fichiers créés, modifiés ou présentés pendant la conversation (dernier état
 * par chemin, le plus récent en premier).
 */
export function changedFiles(messages: readonly ChatMessage[]): FileCardData[] {
  const byPath = new Map<string, FileCardData>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_call' || part.display?.type !== 'file') continue;
      const file = part.display.file;
      const previous = byPath.get(file.path);
      byPath.delete(file.path);
      // « Créé » reste « Créé » même si le fichier est ensuite retouché.
      byPath.set(
        file.path,
        previous?.action === 'created' && file.action !== 'created'
          ? { ...file, action: 'created' }
          : file,
      );
    }
  }
  return [...byPath.values()].reverse();
}

const VM_LABELS: Record<SandboxStatus['state'], string> = {
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

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Cpu;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h2
        id={id}
        className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function EnvironmentSection({
  session,
  sandbox,
  server,
  model,
}: {
  session: SessionSummary;
  sandbox: SandboxStatus;
  server: ServerStatus;
  model: string;
}) {
  const switchId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const mountedHere = sandbox.workspace === session.workspace;
  const busyState = ['starting', 'provisioning', 'restarting'].includes(sandbox.state);

  const toggleNetwork = async (enabled: boolean): Promise<void> => {
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

  return (
    <Section title="Environnement" icon={Cpu}>
      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Machine isolée</dt>
          <dd className="flex items-center gap-2">
            {busyState ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <span className={cn('size-2 rounded-full', VM_DOTS[sandbox.state])} aria-hidden />
            )}
            {VM_LABELS[sandbox.state]}
          </dd>
        </div>
        {sandbox.state === 'error' && sandbox.error ? (
          <p className="text-xs text-destructive">{sandbox.error}</p>
        ) : null}
        {sandbox.state === 'ready' && !mountedHere ? (
          <p className="text-xs text-muted-foreground">
            Le dossier de cette conversation sera monté au prochain message.
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            <Server className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
            Serveur
          </dt>
          <dd className="truncate text-right" title={model}>
            {serverStatusText(server)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Modèle</dt>
          <dd className="truncate font-mono text-xs" title={model}>
            {model}
          </dd>
        </div>
      </dl>

      <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
        <div className="space-y-0.5">
          <label htmlFor={switchId} className="flex items-center gap-1.5 text-sm font-medium">
            <Globe className="size-3.5" aria-hidden />
            Internet pour les commandes
          </label>
          <p id={`${switchId}-hint`} className="text-xs text-muted-foreground">
            Coupé par défaut. La recherche web de l’assistant reste disponible.
          </p>
        </div>
        <button
          id={switchId}
          type="button"
          role="switch"
          aria-checked={sandbox.networkEnabled && mountedHere}
          aria-describedby={`${switchId}-hint`}
          disabled={busy || sandbox.state !== 'ready' || !mountedHere}
          onClick={() => void toggleNetwork(!(sandbox.networkEnabled && mountedHere))}
          className={cn(
            'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            sandbox.networkEnabled && mountedHere ? 'bg-primary' : 'bg-input',
          )}
        >
          <span
            className={cn(
              'inline-block size-4 rounded-full bg-background shadow transition-transform',
              sandbox.networkEnabled && mountedHere ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

export function SidePanel({
  id,
  session,
  view,
  sandbox,
  server,
  model,
}: {
  id: string;
  session: SessionSummary;
  view: SessionView;
  sandbox: SandboxStatus;
  server: ServerStatus;
  model: string;
}) {
  const files = changedFiles(view.live ? [...view.messages, view.live] : view.messages);
  return (
    <aside
      id={id}
      aria-label="Suivi de la conversation"
      className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-l bg-muted/20 px-4 py-5"
    >
      <Section title="Tâches" icon={ListChecks}>
        {view.todos.length > 0 ? (
          <div aria-live="polite">
            <TodoList todos={view.todos} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Pour une demande en plusieurs étapes, l’assistant affiche ici son plan.
          </p>
        )}
      </Section>

      <Section title="Fichiers" icon={FileText}>
        {files.length > 0 ? (
          <ul className="space-y-2">
            {files.map((file) => (
              <li key={file.path}>
                <FileCard file={file} compact />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Les fichiers créés ou modifiés apparaîtront ici.
          </p>
        )}
      </Section>

      <EnvironmentSection session={session} sandbox={sandbox} server={server} model={model} />
    </aside>
  );
}
