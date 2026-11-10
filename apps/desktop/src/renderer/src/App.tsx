import { Loader2 } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { isCharterAccepted } from '@atelier/shared';
import { Workspace } from '@renderer/features/Workspace';
import { CharterGate } from '@renderer/features/legal/CharterGate';
import { Onboarding } from '@renderer/features/onboarding/Onboarding';
import { errorMessage } from '@renderer/lib/error-messages';
import { AppStateProvider, useAppStatus } from '@renderer/state/app-state';

function Root() {
  const status = useAppStatus();
  if (status.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Chargement…</span>
      </div>
    );
  }
  if (status.status === 'error') {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col justify-center gap-4 px-6">
        <Alert tone="error" title="YodAI n’a pas pu démarrer">
          {errorMessage(status.error)}
        </Alert>
        <Button variant="outline" onClick={status.retry} className="self-start">
          Réessayer
        </Button>
      </div>
    );
  }
  const { settings } = status.state;
  if (!settings.onboardingCompleted) return <Onboarding />;
  // Charte d'usage (#43) : acceptée dans l'onboarding, sinon représentée ici.
  return isCharterAccepted(settings) ? <Workspace /> : <CharterGate />;
}

export function App() {
  return (
    <AppStateProvider>
      <Root />
    </AppStateProvider>
  );
}
