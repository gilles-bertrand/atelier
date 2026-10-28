import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import type { SandboxProgress, SandboxStatus } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Progress } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { useApp } from '@renderer/state/app-state';
import { StepCard } from './StepCard';

type Phase = 'idle' | 'preparing' | 'ready' | 'error';

/** Phase affichée à partir de l'état de la VM et d'une préparation en cours. */
export function sandboxPhase(status: SandboxStatus, preparing: boolean): Phase {
  if (status.state === 'ready') return 'ready';
  if (status.state === 'error') return 'error';
  if (preparing || ['starting', 'provisioning', 'restarting'].includes(status.state)) {
    return 'preparing';
  }
  return 'idle';
}

/** Libellé de la progression (le message du main est déjà en français). */
export function progressLabel(progress: SandboxProgress | undefined): string {
  return progress?.message ?? 'Démarrage…';
}

export function SandboxStep({ onBack }: { onBack: () => void }) {
  const { state, actions } = useApp();
  const [preparing, setPreparing] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [finishing, setFinishing] = useState(false);
  const phase = failure ? 'error' : sandboxPhase(state.sandbox, preparing);

  const prepare = async (): Promise<void> => {
    setPreparing(true);
    setFailure(undefined);
    try {
      await call('sandbox:ensure-ready');
    } catch (e) {
      // L'état `error` de la VM porte souvent un message plus précis.
      setFailure(errorMessage(toSerializedError(e)));
    } finally {
      setPreparing(false);
    }
  };

  const finish = async (): Promise<void> => {
    setFinishing(true);
    try {
      await actions.updateSettings({ onboardingCompleted: true });
    } catch (e) {
      setFailure(errorMessage(toSerializedError(e)));
      setFinishing(false);
    }
  };

  const finishLabel =
    phase === 'ready'
      ? 'Commencer'
      : phase === 'preparing'
        ? 'Continuer pendant la préparation'
        : 'Terminer sans l’environnement';

  return (
    <StepCard
      title="Environnement d’exécution"
      description="Pour créer des tableurs, convertir des documents ou faire des calculs, l’assistant utilise une petite machine Linux isolée sur votre Mac. Elle ne voit que le dossier que vous lui confiez."
      footer={
        <>
          <Button variant="ghost" onClick={onBack} disabled={finishing}>
            Retour
          </Button>
          <Button
            variant={phase === 'ready' ? 'default' : 'outline'}
            onClick={() => void finish()}
            disabled={finishing}
          >
            {finishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {finishLabel}
          </Button>
        </>
      }
    >
      {phase === 'idle' ? (
        <div className="space-y-3">
          <Hint>
            Première préparation : environ 10 minutes et 600 Mo à télécharger. Les démarrages
            suivants prennent quelques secondes.
          </Hint>
          <Button onClick={() => void prepare()}>Préparer l’environnement</Button>
        </div>
      ) : null}

      {phase === 'preparing' ? (
        <div className="space-y-2" aria-live="polite">
          <Progress
            value={state.sandboxProgress?.progress}
            label="Préparation de l’environnement"
          />
          <p className="text-sm text-muted-foreground">{progressLabel(state.sandboxProgress)}</p>
          <Hint>Vous pouvez continuer : la préparation se poursuit en arrière-plan.</Hint>
        </div>
      ) : null}

      {phase === 'ready' ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
          L’environnement est prêt.
        </p>
      ) : null}

      {phase === 'error' ? (
        <div className="space-y-3">
          <Alert tone="error" title="Préparation impossible">
            {state.sandbox.error ?? failure ?? 'Erreur inconnue.'}
          </Alert>
          <Hint>
            L’assistant fonctionne sans cet environnement (lecture et écriture de fichiers,
            recherche), mais ne peut pas exécuter de commandes.
          </Hint>
          <Button variant="outline" onClick={() => void prepare()}>
            Réessayer
          </Button>
        </div>
      ) : null}
    </StepCard>
  );
}
