/** Réglages du serveur LLM : adresse, jeton, modèle, réflexion, vision, contexte. */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ConnectionTestResult, LlmModelInfo } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label, Select, Switch } from '@renderer/components/ui/primitives';
import { call } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatContext } from '@renderer/lib/format';
import { useApp } from '@renderer/state/app-state';
import { chatModels } from '../onboarding/ModelStep';
import { validateServerUrl } from '../onboarding/ServerStep';
import { FeedbackLine, SettingsSection, useAction } from './common';

function ConnectionSettings() {
  const { state, actions } = useApp();
  const ids = { url: useId(), token: useId(), tokenHint: useId() };
  const [baseUrl, setBaseUrl] = useState(state.settings.llm.baseUrl);
  const [token, setToken] = useState('');
  const [result, setResult] = useState<ConnectionTestResult | undefined>();
  const test = useAction();
  const save = useAction();
  const urlError = validateServerUrl(baseUrl);
  const changedServer = baseUrl.trim() !== state.settings.llm.baseUrl;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.url}>Adresse du serveur</Label>
        <Input
          id={ids.url}
          type="url"
          spellCheck={false}
          value={baseUrl}
          aria-invalid={urlError ? true : undefined}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setResult(undefined);
            save.clear();
          }}
        />
        {urlError && baseUrl !== '' ? <Hint className="text-destructive">{urlError}</Hint> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.token}>Jeton d’accès (token)</Label>
        <Input
          id={ids.token}
          type="password"
          autoComplete="off"
          value={token}
          aria-describedby={ids.tokenHint}
          placeholder={state.secrets.llm_token ? 'Jeton enregistré' : 'Facultatif'}
          onChange={(e) => {
            setToken(e.target.value);
            setResult(undefined);
          }}
        />
        <Hint id={ids.tokenHint}>
          {changedServer && state.secrets.llm_token
            ? 'Nouveau serveur : ressaisissez son jeton (le jeton enregistré n’est envoyé qu’au serveur enregistré).'
            : 'Conservé chiffré dans le trousseau du Mac. Laissez vide pour garder le jeton enregistré.'}
        </Hint>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={Boolean(urlError) || test.busy}
          onClick={() =>
            void test.run(async () => {
              const trimmed = token.trim();
              setResult(
                await call('llm:test-connection', {
                  baseUrl: baseUrl.trim(),
                  ...(trimmed ? { token: trimmed } : {}),
                }),
              );
            })
          }
        >
          {test.busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Tester la connexion
        </Button>
        <Button
          disabled={Boolean(urlError) || save.busy || (!changedServer && token.trim() === '')}
          onClick={() =>
            void save.run(async () => {
              if (changedServer) await actions.updateSettings({ llm: { baseUrl: baseUrl.trim() } });
              if (token.trim() !== '') await actions.setSecret('llm_token', token.trim());
              setToken('');
            }, 'Connexion enregistrée.')
          }
        >
          Enregistrer
        </Button>
        {state.secrets.llm_token ? (
          <Button
            variant="ghost"
            disabled={save.busy}
            onClick={() =>
              void save.run(() => actions.setSecret('llm_token', null), 'Jeton effacé.')
            }
          >
            Effacer le jeton
          </Button>
        ) : null}
      </div>
      <div aria-live="polite" className="space-y-2">
        {result?.ok ? (
          <Alert tone="success" title="Connexion réussie">
            {[
              result.latencyMs !== undefined ? `${String(result.latencyMs)} ms` : undefined,
              result.serverVersion ? `version ${result.serverVersion}` : undefined,
              `${String(result.models.length)} modèle(s)`,
              result.contextWindow !== undefined ? formatContext(result.contextWindow) : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Alert>
        ) : null}
        {result && !result.ok ? (
          <Alert tone="error" title="Connexion impossible">
            {result.errorCode ? errorMessage({ code: result.errorCode }) : 'Erreur inconnue.'}
          </Alert>
        ) : null}
        <FeedbackLine feedback={test.feedback ?? save.feedback} />
      </div>
    </div>
  );
}

function ModelSettings() {
  const { state, actions } = useApp();
  const { llm } = state.settings;
  const ids = {
    model: useId(),
    vision: useId(),
    ctx: useId(),
    ctxHint: useId(),
    thinking: useId(),
  };
  const [models, setModels] = useState<LlmModelInfo[] | undefined>();
  const [model, setModel] = useState(llm.model);
  const [vision, setVision] = useState(llm.visionModel ?? '');
  const [numCtx, setNumCtx] = useState(llm.numCtx !== undefined ? String(llm.numCtx) : '');
  const save = useAction();
  const load = useAction();

  useEffect(() => {
    void load.run(async () => {
      setModels(chatModels(await call('llm:list-models')));
    });
    // Chargement unique à l'ouverture de la section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llm.baseUrl]);

  const names = models?.map((m) => m.name) ?? [];
  const options = names.includes(model) ? names : [model, ...names];
  const ctxValue = numCtx.trim() === '' ? 0 : Number(numCtx);
  const ctxInvalid = !Number.isInteger(ctxValue) || (ctxValue !== 0 && ctxValue < 2048);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.model}>Modèle principal</Label>
          <Select
            id={ids.model}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.vision}>Modèle pour les images</Label>
          <Select
            id={ids.vision}
            value={vision}
            onChange={(e) => {
              setVision(e.target.value);
            }}
          >
            <option value="">Le modèle principal</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {load.feedback?.tone === 'error' ? (
        <Hint className="text-destructive">
          Liste des modèles indisponible : {load.feedback.message}
        </Hint>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={ids.ctx}>Fenêtre de contexte (tokens)</Label>
        <Input
          id={ids.ctx}
          inputMode="numeric"
          placeholder="Automatique (lue sur le serveur)"
          value={numCtx}
          aria-invalid={ctxInvalid ? true : undefined}
          aria-describedby={ids.ctxHint}
          onChange={(e) => {
            setNumCtx(e.target.value.replace(/[^\d]/g, ''));
          }}
          className="max-w-60"
        />
        <Hint id={ids.ctxHint} className={ctxInvalid ? 'text-destructive' : undefined}>
          {ctxInvalid
            ? 'Indiquez au moins 2048, ou laissez vide.'
            : 'Laissez vide : Atelier lit la valeur configurée sur le serveur.'}
        </Hint>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="space-y-0.5">
          <label htmlFor={ids.thinking} className="text-sm font-medium">
            Réflexion approfondie
          </label>
          <Hint>Réponses plus fiables pour l’analyse et les calculs, un peu plus lentes.</Hint>
        </div>
        <Switch
          id={ids.thinking}
          checked={llm.thinking}
          onCheckedChange={(thinking) =>
            void save.run(() => actions.updateSettings({ llm: { thinking } }))
          }
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          disabled={save.busy || ctxInvalid}
          onClick={() =>
            void save.run(
              () =>
                actions.updateSettings({ llm: { model, visionModel: vision, numCtx: ctxValue } }),
              'Modèles enregistrés. Ils s’appliquent au prochain message.',
            )
          }
        >
          Enregistrer
        </Button>
        <FeedbackLine feedback={save.feedback} />
      </div>
    </div>
  );
}

export function ServerSettings() {
  return (
    <>
      <SettingsSection
        title="Serveur"
        description="Le serveur d’IA de votre organisation. Vos messages et documents y sont envoyés pour être traités."
      >
        <ConnectionSettings />
      </SettingsSection>
      <SettingsSection title="Modèle">
        <ModelSettings />
      </SettingsSection>
    </>
  );
}
