/**
 * Réglages › Voix (ADR-004 D10) : activer la dictée ; micro (choix, test de
 * 5 s avec vu-mètre et transcription) ; modèle de reconnaissance (état, taille,
 * téléchargement, import, suppression) ; source des modèles (officielle ou
 * miroir) ; libération de la mémoire après N minutes.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Download, FileUp, Loader2, Mic, Trash2 } from 'lucide-react';
import {
  DEFAULT_VOICE_SETTINGS,
  MAX_VOICE_IDLE_UNLOAD_MINUTES,
  validateVoiceSettings,
  type AppSettingsPatch,
  type MicAccess,
  type VoiceEngineState,
  type VoiceModelInfo,
} from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label, Select, Switch } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatBytes } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { dictationBlocker, isMicBlocked, modelStateLabel } from '@renderer/lib/voice';
import { useApp } from '@renderer/state/app-state';
import { listMicrophones } from '../voice/capture';
import { useDictation } from '../voice/useDictation';
import { useVoiceStatus } from '../voice/useVoiceStatus';
import { LevelMeter, MicDeniedAlert, ModelProgress, voiceErrorText } from '../voice/VoiceParts';
import { FeedbackLine, SettingsSection, useAction } from './common';

/** Durée du test du micro. */
const MIC_TEST_MS = 5_000;

const MIC_ACCESS_LABELS: Record<MicAccess, string> = {
  granted: 'autorisé',
  denied: 'refusé',
  'not-determined': 'pas encore demandé',
  restricted: 'bloqué par une règle de l’entreprise',
  unknown: 'inconnu',
};

const ENGINE_LABELS: Record<VoiceEngineState, string> = {
  stopped: 'arrêté (mémoire libérée)',
  loading: 'en cours de chargement',
  ready: 'prêt',
  error: 'en erreur',
};

function useVoiceSettings() {
  const { state, actions } = useApp();
  return {
    settings: state.settings.voice ?? DEFAULT_VOICE_SETTINGS,
    update: (patch: AppSettingsPatch) => actions.updateSettings(patch),
  };
}

export function VoiceSettings() {
  const { status, refresh } = useVoiceStatus({ eager: true });
  const { settings, update } = useVoiceSettings();
  const enableAction = useAction();
  const enabledLabel = useId();

  return (
    <>
      <SettingsSection
        title="Voix"
        description="La dictée transcrit votre voix sur ce Mac : l’audio n’est ni envoyé ni conservé, seul le texte part à l’assistant, comme un message tapé. Le micro ne s’ouvre que quand vous cliquez sur le bouton micro (ou ⌘⇧D)."
      >
        <div className="flex items-center justify-between gap-4">
          <span id={enabledLabel} className="text-sm font-medium">
            Activer la dictée
          </span>
          <Switch
            aria-labelledby={enabledLabel}
            checked={settings.enabled}
            disabled={enableAction.busy}
            onCheckedChange={(enabled) =>
              void enableAction.run(() => update({ voice: { enabled } }))
            }
          />
        </div>
        <FeedbackLine feedback={enableAction.feedback} />
        {status ? <MicAccessRow access={status.mic} onChange={refresh} /> : null}
      </SettingsSection>
      <MicSection deviceId={settings.inputDeviceId} />
      <ModelsSection models={status?.models} engine={status?.engine} />
      <SourceSection />
      <MemorySection />
    </>
  );
}

function MicAccessRow({
  access,
  onChange,
}: {
  access: MicAccess;
  onChange: () => Promise<unknown>;
}) {
  const action = useAction();
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Accès au micro : <span className="font-medium">{MIC_ACCESS_LABELS[access]}</span>
      </p>
      {isMicBlocked(access) ? <MicDeniedAlert /> : null}
      {access === 'not-determined' ? (
        <Button
          variant="outline"
          size="sm"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await call('voice:request-mic');
              await onChange();
            })
          }
        >
          <Mic className="size-3.5" aria-hidden />
          Autoriser le micro
        </Button>
      ) : null}
      <FeedbackLine feedback={action.feedback} />
    </div>
  );
}

// ------------------------------------------------------------------- micro

function MicSection({ deviceId }: { deviceId: string | undefined }) {
  const { update } = useVoiceSettings();
  const selectId = useId();
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const action = useAction();

  const loadDevices = useCallback(() => {
    listMicrophones().then(setDevices, () => {
      setDevices([]);
    });
  }, []);
  useEffect(loadDevices, [loadDevices]);

  const chosen = deviceId ?? '';
  const missing = chosen !== '' && !devices.some((d) => d.deviceId === chosen);

  return (
    <SettingsSection
      title="Micro"
      description="Le micro par défaut du Mac convient le plus souvent. Testez-le : parlez pendant 5 secondes, la transcription s’affiche."
    >
      <div className="space-y-2">
        <Label htmlFor={selectId}>Micro utilisé</Label>
        <Select
          id={selectId}
          value={chosen}
          disabled={action.busy}
          onChange={(e) => {
            const next = e.target.value;
            void action.run(() => update({ voice: { inputDeviceId: next } }));
          }}
        >
          <option value="">Micro par défaut du Mac</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
          {missing ? <option value={chosen}>Micro choisi (débranché)</option> : null}
        </Select>
        <Hint>Les noms des micros s’affichent une fois l’accès au micro autorisé.</Hint>
        <FeedbackLine feedback={action.feedback} />
      </div>
      <MicTest deviceId={deviceId} onTested={loadDevices} />
    </SettingsSection>
  );
}

function MicTest({ deviceId, onTested }: { deviceId: string | undefined; onTested: () => void }) {
  const { refresh } = useVoiceStatus();
  const { settings } = useVoiceSettings();
  const [result, setResult] = useState<string | undefined>();
  const [blocker, setBlocker] = useState<'mic_denied' | 'model' | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [preparing, setPreparing] = useState(false);
  const dictation = useDictation({
    deviceId,
    maxMs: MIC_TEST_MS,
    onDone: (text) => {
      setResult(text.trim());
      onTested();
    },
  });

  const run = async (): Promise<void> => {
    setResult(undefined);
    setBlocker(undefined);
    setFailure(undefined);
    setPreparing(true);
    try {
      let current = await refresh();
      if (current.mic === 'not-determined') {
        current = { ...current, mic: await call('voice:request-mic') };
      }
      const missing = dictationBlocker(current, settings);
      if (missing !== undefined) {
        setBlocker(missing);
        return;
      }
    } catch (e) {
      setFailure(voiceErrorText(toSerializedError(e)));
      return;
    } finally {
      setPreparing(false);
    }
    await dictation.start();
  };

  const { phase, active } = dictation;
  const remaining = Math.max(0, Math.ceil((MIC_TEST_MS - dictation.elapsedMs) / 1000));
  const error = dictation.error;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={active ? 'destructive' : 'outline'}
          size="sm"
          disabled={preparing}
          onClick={() => {
            if (active) dictation.cancel();
            else void run();
          }}
        >
          {preparing || phase === 'opening' || phase === 'transcribing' ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Mic className="size-3.5" aria-hidden />
          )}
          {active ? 'Arrêter le test' : 'Tester le micro (5 s)'}
        </Button>
        {phase === 'starting' || phase === 'listening' ? (
          <span className="flex items-center gap-2 text-sm tabular-nums">
            <LevelMeter level={dictation.level} className="w-24" />
            {phase === 'listening' ? `Parlez… ${String(remaining)} s` : 'Ouverture du micro…'}
          </span>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {phase === 'listening'
          ? 'Micro ouvert : parlez.'
          : phase === 'transcribing'
            ? 'Transcription en cours…'
            : result !== undefined
              ? 'Test terminé.'
              : ''}
      </p>
      {result !== undefined ? (
        <p
          className="rounded-lg border bg-muted/30 px-3 py-2 text-sm"
          data-testid="mic-test-result"
        >
          {result === '' ? (
            'Aucun texte reconnu. Parlez plus près du micro, ou choisissez-en un autre.'
          ) : (
            <>Transcription : « {result} »</>
          )}
        </p>
      ) : null}
      {blocker === 'mic_denied' || error?.code === 'voice/mic_denied' ? <MicDeniedAlert /> : null}
      {blocker === 'model' ||
      error?.code === 'voice/model_missing' ||
      error?.code === 'voice/model_invalid' ? (
        <Alert tone="warning">
          Le test a besoin du modèle de reconnaissance : téléchargez-le ci-dessous.
        </Alert>
      ) : null}
      {error &&
      error.code !== 'voice/mic_denied' &&
      error.code !== 'voice/model_missing' &&
      error.code !== 'voice/model_invalid' ? (
        <Alert tone="error">{voiceErrorText(error)}</Alert>
      ) : null}
      {dictation.warning === 'silent_input' && active ? (
        <Alert tone="warning">
          Aucun son ne parvient du micro. Vérifiez qu’il n’est pas coupé, ou choisissez-en un autre.
        </Alert>
      ) : null}
      {failure !== undefined ? <Alert tone="error">{failure}</Alert> : null}
    </div>
  );
}

// ------------------------------------------------------------------ modèles

function ModelsSection({
  models,
  engine,
}: {
  models: VoiceModelInfo[] | undefined;
  engine: VoiceEngineState | undefined;
}) {
  return (
    <SettingsSection
      title="Reconnaissance vocale"
      description="Le modèle est téléchargé une fois, vérifié par son empreinte, puis tout est traité sur ce Mac. Aucune langue à choisir : le français, le néerlandais et l’anglais sont reconnus d’eux-mêmes."
    >
      {engine ? (
        <p className="text-sm">
          Moteur : <span className="font-medium">{ENGINE_LABELS[engine]}</span>
        </p>
      ) : null}
      {models === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Lecture de l’état des modèles…
        </p>
      ) : (
        <ul className="space-y-3">
          {models.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function ModelRow({ model }: { model: VoiceModelInfo }) {
  const action = useAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const installed = model.state === 'installed' || model.state === 'loaded';
  const run = (task: () => Promise<unknown>, success?: string): void => {
    void action.run(async () => {
      try {
        await task();
      } catch (e) {
        // Téléchargement annulé par l'utilisateur : pas une erreur à afficher.
        if (toSerializedError(e).details?.['reason'] === 'cancelled') return;
        throw e;
      }
    }, success);
  };
  return (
    <li className="space-y-3 rounded-lg border px-4 py-3" aria-label={model.label}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{model.label}</span>
        <span
          className={cn(
            'text-xs',
            model.state === 'error' ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {modelStateLabel(model)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {model.bundled
          ? `${formatBytes(model.diskBytes)}, embarqué dans l’app`
          : `Téléchargement ${formatBytes(model.downloadBytes)}, ${formatBytes(model.diskBytes)} sur le disque, environ ${formatBytes(model.memoryEstimateBytes)} de mémoire une fois chargé`}
        {` · licence ${model.license}`}
      </p>
      {model.state === 'downloading' ? <ModelProgress model={model} /> : null}
      {model.state === 'error' && model.error ? (
        <Alert tone="error">{errorMessage(model.error)}</Alert>
      ) : null}
      {model.bundled ? null : (
        <div className="flex flex-wrap gap-2">
          {model.state === 'downloading' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                call('voice:cancel-install', { id: model.id }).catch(() => undefined);
              }}
            >
              Annuler le téléchargement
            </Button>
          ) : installed ? (
            confirmRemove ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={action.busy}
                  onClick={() => {
                    setConfirmRemove(false);
                    run(() => call('voice:remove-model', { id: model.id }), 'Modèle supprimé.');
                  }}
                >
                  Confirmer la suppression
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmRemove(false);
                  }}
                >
                  Garder
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Supprimer
              </Button>
            )
          ) : (
            <>
              <Button
                size="sm"
                disabled={action.busy}
                onClick={() => {
                  run(() => call('voice:install-model', { id: model.id }), 'Modèle installé.');
                }}
              >
                <Download className="size-3.5" aria-hidden />
                {model.state === 'error' ? 'Réessayer' : 'Télécharger'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() => {
                  run(() => call('voice:import-model', { id: model.id }));
                }}
              >
                <FileUp className="size-3.5" aria-hidden />
                Importer une archive…
              </Button>
            </>
          )}
        </div>
      )}
      {confirmRemove ? (
        <Hint>
          La dictée ne fonctionnera plus tant que le modèle n’est pas téléchargé à nouveau.
        </Hint>
      ) : null}
      {model.attribution ? <Hint>{model.attribution}</Hint> : null}
      <FeedbackLine feedback={action.feedback} />
    </li>
  );
}

// --------------------------------------------------------- source, mémoire

function SourceSection() {
  const { settings, update } = useVoiceSettings();
  const urlId = useId();
  const action = useAction();
  const current = settings.modelSourceUrl ?? '';
  const [mirror, setMirror] = useState(current !== '');
  const [url, setUrl] = useState(current);
  const [invalid, setInvalid] = useState<string | undefined>();

  const save = (next: string): void => {
    const issue = validateVoiceSettings({ ...settings, modelSourceUrl: next });
    if (issue) {
      setInvalid(issue.message);
      return;
    }
    setInvalid(undefined);
    void action.run(
      () => update({ voice: { modelSourceUrl: next } }),
      next === '' ? 'Source officielle rétablie.' : 'Miroir enregistré.',
    );
  };

  return (
    <SettingsSection
      title="Source des modèles"
      description="Les empreintes des modèles sont inscrites dans l’app : un miroir ne peut pas fournir un autre fichier. Sans connexion, importez l’archive depuis la rubrique Reconnaissance vocale."
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Source des modèles</legend>
        {(
          [
            {
              id: false,
              label: 'Officielle',
              hint: 'Publications du projet sherpa-onnx (GitHub).',
            },
            {
              id: true,
              label: 'Miroir interne',
              hint: 'Un serveur de votre organisation, par exemple celui du LLM.',
            },
          ] as const
        ).map((option) => (
          <label
            key={option.label}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              mirror === option.id ? 'border-primary bg-accent' : 'hover:bg-accent/60',
            )}
          >
            <input
              type="radio"
              name="voice-model-source"
              checked={mirror === option.id}
              disabled={action.busy}
              onChange={() => {
                setMirror(option.id);
                setInvalid(undefined);
                if (!option.id && current !== '') {
                  setUrl('');
                  save('');
                }
              }}
              className="mt-0.5 size-4 accent-brand"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mirror ? (
        <div className="space-y-2">
          <Label htmlFor={urlId}>Adresse du miroir</Label>
          <div className="flex gap-2">
            <Input
              id={urlId}
              type="url"
              placeholder="https://llm.exemple.fr/models/voice/"
              value={url}
              aria-invalid={invalid !== undefined}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
            <Button
              variant="outline"
              disabled={action.busy || url.trim() === '' || url.trim() === current}
              onClick={() => {
                save(url.trim());
              }}
            >
              Enregistrer
            </Button>
          </div>
          <Hint>https:// obligatoire, sauf pour localhost ou une adresse Tailscale.</Hint>
          {invalid !== undefined ? (
            <p role="alert" className="text-sm text-destructive">
              {invalid}
            </p>
          ) : null}
        </div>
      ) : null}
      <FeedbackLine feedback={action.feedback} />
    </SettingsSection>
  );
}

function MemorySection() {
  const { settings, update } = useVoiceSettings();
  const inputId = useId();
  const action = useAction();
  const [minutes, setMinutes] = useState(String(settings.idleUnloadMinutes));
  const [invalid, setInvalid] = useState<string | undefined>();
  const parsed = Number(minutes);

  return (
    <SettingsSection
      title="Mémoire"
      description="Chargé, le moteur occupe environ 1,5 Go de mémoire. Il est libéré après un temps d’inactivité, puis rechargé en une seconde environ à la dictée suivante."
    >
      <div className="space-y-2">
        <Label htmlFor={inputId}>Libérer la mémoire après (minutes)</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_VOICE_IDLE_UNLOAD_MINUTES}
            step={1}
            className="w-32"
            value={minutes}
            aria-invalid={invalid !== undefined}
            onChange={(e) => {
              setMinutes(e.target.value);
            }}
          />
          <Button
            variant="outline"
            disabled={action.busy || parsed === settings.idleUnloadMinutes}
            onClick={() => {
              const issue = validateVoiceSettings({ ...settings, idleUnloadMinutes: parsed });
              if (minutes.trim() === '' || issue) {
                setInvalid(
                  issue?.message ??
                    'Indiquez un nombre entier de minutes (0 garde le moteur chargé).',
                );
                return;
              }
              setInvalid(undefined);
              void action.run(
                () => update({ voice: { idleUnloadMinutes: parsed } }),
                'Délai enregistré.',
              );
            }}
          >
            Enregistrer
          </Button>
        </div>
        <Hint>0 garde le moteur chargé tant que l’app est ouverte.</Hint>
        {invalid !== undefined ? (
          <p role="alert" className="text-sm text-destructive">
            {invalid}
          </p>
        ) : null}
        <FeedbackLine feedback={action.feedback} />
      </div>
    </SettingsSection>
  );
}
