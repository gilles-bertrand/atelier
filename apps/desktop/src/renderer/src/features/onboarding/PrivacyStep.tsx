import { useId, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { hostOf } from '@renderer/lib/format';
import { useApp } from '@renderer/state/app-state';
import { StepCard } from './StepCard';

export function PrivacyStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { state, actions } = useApp();
  const checkboxId = useId();
  const [accepted, setAccepted] = useState(state.settings.privacyAcceptedAt !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const host = hostOf(state.settings.llm.baseUrl);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await actions.updateSettings({ privacyAcceptedAt: new Date().toISOString() });
      onDone();
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepCard
      title="Où vont vos données"
      footer={
        <>
          <Button variant="ghost" onClick={onBack}>
            Retour
          </Button>
          <Button onClick={() => void save()} disabled={!accepted || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Continuer
          </Button>
        </>
      }
    >
      <div className="flex gap-3 text-sm leading-relaxed">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-3">
          <p>
            Vos messages, ainsi que le contenu des fichiers et des images que l’assistant lit, sont
            envoyés au serveur <strong className="font-medium">{host}</strong> pour être traités.
          </p>
          <p>
            Aucun service d’IA dans le cloud n’est utilisé. Les fichiers restent dans le dossier que
            vous choisissez ; les commandes s’exécutent dans un environnement isolé sur votre Mac.
          </p>
          <p className="text-muted-foreground">
            Quand l’assistant cherche sur internet, la question part vers le moteur de recherche
            choisi dans les Réglages.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-3">
        <input
          id={checkboxId}
          type="checkbox"
          checked={accepted}
          onChange={(e) => {
            setAccepted(e.target.checked);
          }}
          className="mt-0.5 size-4 accent-primary"
        />
        <label htmlFor={checkboxId} className="text-sm">
          J’ai compris que mes documents sont envoyés au serveur {host}.
        </label>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
    </StepCard>
  );
}
