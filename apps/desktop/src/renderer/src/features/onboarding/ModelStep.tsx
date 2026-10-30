import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DEFAULT_MODEL, MIN_CONTEXT_WINDOW, type ConnectionTestResult } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatBytes, formatContext } from '@renderer/lib/format';
import {
  chatModels,
  initialModel,
  NO_TOOLS_REASON,
  profileLabel,
  supportsTools,
} from '@renderer/lib/models';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { StepCard } from './StepCard';

export function ModelStep({
  connection,
  onBack,
  onDone,
}: {
  connection: ConnectionTestResult;
  onBack: () => void;
  onDone: () => void;
}) {
  const { state, actions } = useApp();
  const thinkingId = useId();
  const models = chatModels(connection.models);
  const [model, setModel] = useState(() => initialModel(models, state.settings.llm.model));
  const [thinking, setThinking] = useState(state.settings.llm.thinking);
  const [context, setContext] = useState<{ model: string; value?: number } | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Fenêtre de contexte réelle du modèle choisi (lue sur le serveur).
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    call('llm:test-connection', { baseUrl: state.settings.llm.baseUrl, model }).then(
      (result) => {
        if (!cancelled) {
          setContext({
            model,
            ...(result.contextWindow !== undefined ? { value: result.contextWindow } : {}),
          });
        }
      },
      () => {
        if (!cancelled) setContext({ model });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [model, state.settings.llm.baseUrl]);

  const save = async (): Promise<void> => {
    if (!model) return;
    setSaving(true);
    setError(undefined);
    try {
      await actions.updateSettings({ llm: { model, thinking } });
      onDone();
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setSaving(false);
    }
  };

  const contextKnown = context && context.model === model ? context.value : undefined;

  return (
    <StepCard
      title="Choix du modèle"
      description="Les modèles listés sont installés sur votre serveur. Un modèle plus grand rédige mieux mais répond plus lentement."
      footer={
        <>
          <Button variant="ghost" onClick={onBack}>
            Retour
          </Button>
          <Button onClick={() => void save()} disabled={!model || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Continuer
          </Button>
        </>
      }
    >
      {models.length === 0 ? (
        <Alert tone="warning" title="Aucun modèle sur le serveur">
          Demandez à votre administrateur d’installer un modèle (par exemple {DEFAULT_MODEL}), puis
          revenez à l’étape précédente pour tester à nouveau.
        </Alert>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Modèle principal</legend>
          <div className="space-y-2">
            {models.map((m) => {
              const profile = profileLabel(m.name);
              const checked = m.name === model;
              const usable = supportsTools(m);
              return (
                <label
                  key={m.name}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    !usable
                      ? 'cursor-not-allowed opacity-60'
                      : checked
                        ? 'cursor-pointer border-brand bg-brand-soft'
                        : 'cursor-pointer hover:bg-accent/60',
                  )}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.name}
                    checked={checked}
                    disabled={!usable}
                    onChange={() => {
                      setModel(m.name);
                    }}
                    className="size-4 accent-brand"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{m.name}</span>
                    {profile ? (
                      <span className="ml-2 text-xs text-muted-foreground">{profile}</span>
                    ) : null}
                    {!usable ? (
                      <span className="block text-xs text-muted-foreground">
                        Indisponible : {NO_TOOLS_REASON}
                      </span>
                    ) : null}
                  </span>
                  {m.sizeBytes !== undefined ? (
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(m.sizeBytes)}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div aria-live="polite">
        {model && context?.model === model ? (
          contextKnown !== undefined && contextKnown < MIN_CONTEXT_WINDOW ? (
            <Alert tone="warning" title={`Contexte limité : ${formatContext(contextKnown)}`}>
              Les longs documents seront résumés plus souvent. Votre administrateur peut augmenter
              le contexte à {formatContext(MIN_CONTEXT_WINDOW)} (voir docs/SERVER.md).
            </Alert>
          ) : contextKnown !== undefined ? (
            <Hint>Contexte du modèle : {formatContext(contextKnown)}.</Hint>
          ) : null
        ) : null}
      </div>

      <div className="flex items-start gap-3">
        <input
          id={thinkingId}
          type="checkbox"
          checked={thinking}
          onChange={(e) => {
            setThinking(e.target.checked);
          }}
          className="mt-0.5 size-4 accent-brand"
          aria-describedby={`${thinkingId}-hint`}
        />
        <div className="space-y-1">
          <label htmlFor={thinkingId} className="text-sm font-medium">
            Réflexion approfondie
          </label>
          <Hint id={`${thinkingId}-hint`}>
            Recommandé : réponses plus fiables pour l’analyse et les calculs, un peu plus lentes.
            Modifiable dans les Réglages.
          </Hint>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
    </StepCard>
  );
}
