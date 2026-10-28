/** Réglages de la machine isolée : ressources, réseau par défaut, diagnostic, réinitialisation. */
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { SandboxDiagnostics } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label, Progress, Switch } from '@renderer/components/ui/primitives';
import { call } from '@renderer/lib/api';
import { useApp } from '@renderer/state/app-state';
import { FeedbackLine, SettingsSection, useAction } from './common';

const STATE_LABELS = {
  absent: 'pas encore préparée',
  stopped: 'arrêtée',
  starting: 'démarrage…',
  provisioning: 'préparation…',
  ready: 'prête',
  restarting: 'changement de dossier…',
  error: 'indisponible',
} as const;

export function SandboxSettings() {
  const { state, actions } = useApp();
  const { sandbox: settings } = state.settings;
  const ids = { cpus: useId(), memory: useId(), network: useId() };
  const [cpus, setCpus] = useState(String(settings.cpus));
  const [memory, setMemory] = useState(String(settings.memoryGiB));
  const [diagnostics, setDiagnostics] = useState<SandboxDiagnostics | undefined>();
  const [confirmReset, setConfirmReset] = useState(false);
  const save = useAction();
  const network = useAction();
  const diag = useAction();
  const reset = useAction();

  const cpuValue = Number(cpus);
  const memValue = Number(memory);
  const invalid =
    !Number.isInteger(cpuValue) ||
    cpuValue < 1 ||
    cpuValue > 32 ||
    !Number.isInteger(memValue) ||
    memValue < 2 ||
    memValue > 64;

  return (
    <SettingsSection
      title="Machine isolée"
      description="La petite machine Linux où l’assistant exécute ses commandes. Elle ne voit que le dossier de la conversation."
    >
      <p className="text-sm">
        État : <strong className="font-medium">{STATE_LABELS[state.sandbox.state]}</strong>
        {state.sandbox.error ? (
          <span className="block text-xs text-destructive">{state.sandbox.error}</span>
        ) : null}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.cpus}>Processeurs</Label>
          <Input
            id={ids.cpus}
            inputMode="numeric"
            value={cpus}
            onChange={(e) => {
              setCpus(e.target.value.replace(/[^\d]/g, ''));
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.memory}>Mémoire (Gio)</Label>
          <Input
            id={ids.memory}
            inputMode="numeric"
            value={memory}
            onChange={(e) => {
              setMemory(e.target.value.replace(/[^\d]/g, ''));
            }}
          />
        </div>
      </div>
      <Hint className={invalid ? 'text-destructive' : undefined}>
        {invalid
          ? 'Processeurs : 1 à 32. Mémoire : 2 à 64 Gio.'
          : 'Appliqué à la prochaine réinitialisation de la machine.'}
      </Hint>
      <div className="flex items-center gap-3">
        <Button
          disabled={invalid || save.busy}
          onClick={() =>
            void save.run(
              () => actions.updateSettings({ sandbox: { cpus: cpuValue, memoryGiB: memValue } }),
              'Ressources enregistrées.',
            )
          }
        >
          Enregistrer
        </Button>
        <FeedbackLine feedback={save.feedback} />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="space-y-0.5">
          <label htmlFor={ids.network} className="text-sm font-medium">
            Internet autorisé par défaut pour les commandes
          </label>
          <Hint>
            Déconseillé : coupé, l’assistant ne peut rien envoyer sur internet depuis la machine.
            Activable conversation par conversation dans le panneau de suivi.
          </Hint>
        </div>
        <Switch
          id={ids.network}
          checked={settings.networkEnabledByDefault}
          disabled={network.busy}
          onCheckedChange={(enabled) =>
            void network.run(() =>
              actions.updateSettings({ sandbox: { networkEnabledByDefault: enabled } }),
            )
          }
        />
      </div>
      <FeedbackLine feedback={network.feedback} />

      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          disabled={diag.busy}
          onClick={() =>
            void diag.run(async () => {
              setDiagnostics(await call('sandbox:diagnostics'));
            })
          }
        >
          Afficher le diagnostic
        </Button>
        {diagnostics ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        ) : null}
        <FeedbackLine feedback={diag.feedback} />
      </div>

      <div className="space-y-3 rounded-lg border border-destructive/30 px-3 py-3">
        <p className="text-sm font-medium">Réinitialiser la machine</p>
        <Hint>
          Supprime puis recrée la machine (environ 10 minutes). Vos dossiers et documents ne sont
          pas touchés.
        </Hint>
        {reset.busy ? (
          <div className="space-y-2" aria-live="polite">
            <Progress
              value={state.sandboxProgress?.progress}
              label="Réinitialisation de la machine"
            />
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {state.sandboxProgress?.message ?? 'Suppression de la machine…'}
            </p>
          </div>
        ) : confirmReset ? (
          <div className="flex flex-wrap items-center gap-2">
            <Alert tone="warning">Les commandes en cours seront interrompues.</Alert>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmReset(false);
                void reset.run(() => call('sandbox:reset'), 'Machine réinitialisée.');
              }}
            >
              Confirmer la réinitialisation
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmReset(false);
              }}
            >
              Annuler
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              setConfirmReset(true);
            }}
          >
            Réinitialiser…
          </Button>
        )}
        <FeedbackLine feedback={reset.feedback} />
      </div>
    </SettingsSection>
  );
}
