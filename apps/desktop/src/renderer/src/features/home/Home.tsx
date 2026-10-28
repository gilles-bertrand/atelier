import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { useApp } from '@renderer/state/app-state';

/** Accueil provisoire : dossier, sessions récentes et chat arrivent au lot 3. */
export function Home() {
  const { state } = useApp();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-end border-b pl-20 pr-4 [-webkit-app-region:drag]">
        <ServerStatusBadge status={state.server} className="[-webkit-app-region:no-drag]" />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Atelier</h1>
        <p className="text-sm text-muted-foreground">
          Configuration terminée. L’accueil et le chat arrivent bientôt.
        </p>
      </main>
    </div>
  );
}
