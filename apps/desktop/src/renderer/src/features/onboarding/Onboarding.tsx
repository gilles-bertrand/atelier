/**
 * Premier lancement : serveur (URL + token, test), modèle, confidentialité,
 * préparation de la VM. Chaque étape enregistre ses réglages avant de passer
 * à la suivante ; l'onboarding est marqué terminé à la fin.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import type { ConnectionTestResult } from '@atelier/shared';
import { AtelierMark } from '@renderer/components/AtelierMark';
import { cn } from '@renderer/lib/utils';
import { ModelStep } from './ModelStep';
import { PrivacyStep } from './PrivacyStep';
import { ServerStep } from './ServerStep';
import { SandboxStep } from './SandboxStep';

export const ONBOARDING_STEPS = ['Serveur', 'Modèle', 'Confidentialité', 'Environnement'] as const;

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [connection, setConnection] = useState<ConnectionTestResult | undefined>();
  const next = (): void => {
    setStep((s) => Math.min(s + 1, ONBOARDING_STEPS.length - 1));
  };
  const back = (): void => {
    setStep((s) => Math.max(s - 1, 0));
  };

  return (
    <main className="flex min-h-full flex-col items-center overflow-y-auto bg-muted/30 px-6 pb-12 pt-14">
      {/* Barre de titre masquée (hiddenInset) : bande de déplacement de la fenêtre. */}
      <div className="fixed inset-x-0 top-0 h-10 [-webkit-app-region:drag]" aria-hidden />
      <div className="w-full max-w-xl space-y-6">
        <header className="flex flex-col items-center gap-1 text-center">
          <AtelierMark className="mb-3 size-14" />
          <h1 className="text-2xl font-semibold tracking-tight">Bienvenue dans Atelier</h1>
          <p className="text-sm text-muted-foreground">
            Quelques réglages et votre assistant est prêt.
          </p>
        </header>

        <nav aria-label="Étapes de la configuration">
          <ol className="flex items-center justify-between gap-2">
            {ONBOARDING_STEPS.map((label, index) => {
              const done = index < step;
              const current = index === step;
              return (
                <li
                  key={label}
                  aria-current={current ? 'step' : undefined}
                  className="flex flex-1 items-center gap-2 text-xs"
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium',
                      done && 'border-brand bg-brand text-brand-foreground',
                      current && 'border-brand text-foreground',
                      !done && !current && 'text-muted-foreground',
                    )}
                    aria-hidden
                  >
                    {done ? <Check className="size-3.5" /> : index + 1}
                  </span>
                  <span className={cn(current ? 'font-medium' : 'text-muted-foreground')}>
                    {label}
                    {done ? <span className="sr-only"> (terminé)</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>

        {step === 0 ? (
          <ServerStep
            onDone={(result) => {
              setConnection(result);
              next();
            }}
          />
        ) : null}
        {step === 1 && connection ? (
          <ModelStep connection={connection} onBack={back} onDone={next} />
        ) : null}
        {step === 2 ? <PrivacyStep onBack={back} onDone={next} /> : null}
        {step === 3 ? <SandboxStep onBack={back} /> : null}
      </div>
    </main>
  );
}
