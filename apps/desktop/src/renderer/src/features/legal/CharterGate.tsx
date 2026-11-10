/**
 * Charte d'usage à accepter avant d'utiliser YodAI (#43) : affichée quand
 * l'onboarding est terminé mais que la version courante de la charte n'a pas
 * été acceptée (utilisateur existant, ou charte modifiée).
 */
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CHARTER_VERSION } from '@atelier/shared';
import { AtelierMark } from '@renderer/components/AtelierMark';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { useApp } from '@renderer/state/app-state';
import { StepCard } from '../onboarding/StepCard';
import { LegalText } from './LegalText';
import { CHARTER_TEXT } from './texts';

export function CharterGate() {
  const { state, actions } = useApp();
  const checkboxId = useId();
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const changed = state.settings.charterAcceptedVersion !== undefined;

  const accept = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await actions.updateSettings({
        charterAcceptedVersion: CHARTER_VERSION,
        charterAcceptedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
      setSaving(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center overflow-y-auto bg-muted/30 px-6 pb-12 pt-14">
      <div className="fixed inset-x-0 top-0 h-10 [-webkit-app-region:drag]" aria-hidden />
      <div className="w-full max-w-2xl space-y-6">
        <header className="flex flex-col items-center gap-1 text-center">
          <AtelierMark className="mb-3 size-14" />
        </header>
        <StepCard
          title={changed ? 'La charte d’usage a changé' : 'Charte d’usage de YodAI'}
          description="Lisez-la, puis acceptez-la pour continuer. Elle reste consultable dans Réglages › À propos et licences."
          footer={
            <>
              <span />
              <Button onClick={() => void accept()} disabled={!accepted || saving}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Accepter et continuer
              </Button>
            </>
          }
        >
          <LegalText text={CHARTER_TEXT} label="Charte d’usage" />
          <CharterCheckbox id={checkboxId} checked={accepted} onChange={setAccepted} />
          {error ? <Alert tone="error">{error}</Alert> : null}
        </StepCard>
      </div>
    </main>
  );
}

export function CharterCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        className="mt-0.5 size-4 accent-brand"
      />
      <label htmlFor={id} className="text-sm">
        J’ai lu la charte d’usage et je m’engage à la respecter, y compris les usages interdits de
        la voix de synthèse.
      </label>
    </div>
  );
}
