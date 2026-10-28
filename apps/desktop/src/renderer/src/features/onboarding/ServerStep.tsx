import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { checkServerUrl, type ConnectionTestResult } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatContext } from '@renderer/lib/format';
import { useApp } from '@renderer/state/app-state';
import { StepCard } from './StepCard';

/** Message de validation locale de l'URL, ou `undefined` si elle est acceptable. */
export function validateServerUrl(raw: string): string | undefined {
  if (raw.trim() === '') return 'Indiquez l’adresse du serveur.';
  const check = checkServerUrl(raw);
  if (check.ok) return undefined;
  if (check.reason === 'insecure_http') {
    return 'Utilisez https:// : http:// n’est accepté que pour localhost et les adresses Tailscale.';
  }
  return 'Adresse invalide. Exemple : https://llm.mon-entreprise.fr';
}

export function ServerStep({ onDone }: { onDone: (result: ConnectionTestResult) => void }) {
  const { state, actions } = useApp();
  const ids = { url: useId(), urlHint: useId(), token: useId(), tokenHint: useId() };
  const [baseUrl, setBaseUrl] = useState(state.settings.llm.baseUrl);
  const [token, setToken] = useState('');
  const [touched, setTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();

  const urlError = touched ? validateServerUrl(baseUrl) : undefined;
  const tokenSaved = state.secrets.llm_token;

  const test = async (event?: { preventDefault(): void }): Promise<void> => {
    event?.preventDefault();
    setTouched(true);
    if (validateServerUrl(baseUrl)) return;
    setTesting(true);
    setResult(undefined);
    try {
      const trimmed = token.trim();
      setResult(
        await call('llm:test-connection', {
          baseUrl: baseUrl.trim(),
          ...(trimmed ? { token: trimmed } : {}),
        }),
      );
    } catch (error) {
      const serialized = toSerializedError(error);
      setResult({ ok: false, models: [], errorCode: serialized.code });
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!result?.ok) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await actions.updateSettings({ llm: { baseUrl: baseUrl.trim() } });
      if (token.trim() !== '') await actions.setSecret('llm_token', token.trim());
      onDone(result);
    } catch (error) {
      setSaveError(errorMessage(toSerializedError(error)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepCard
      title="Connexion au serveur"
      description="Atelier utilise un modèle d’IA installé sur un serveur de votre organisation. Ces informations vous sont données par votre administrateur."
      footer={
        <>
          <span />
          <Button onClick={() => void save()} disabled={!result?.ok || saving || testing}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Continuer
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={(e) => void test(e)} noValidate>
        <div className="space-y-2">
          <Label htmlFor={ids.url}>Adresse du serveur</Label>
          <Input
            id={ids.url}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://llm.mon-entreprise.fr"
            value={baseUrl}
            aria-invalid={urlError ? true : undefined}
            aria-describedby={ids.urlHint}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setResult(undefined);
            }}
            onBlur={() => {
              if (baseUrl !== '') setTouched(true);
            }}
          />
          <Hint id={ids.urlHint} className={urlError ? 'text-destructive' : undefined}>
            {urlError ??
              'https:// obligatoire, sauf pour un serveur local (localhost) ou joint par Tailscale.'}
          </Hint>
        </div>

        <div className="space-y-2">
          <Label htmlFor={ids.token}>Jeton d’accès (token)</Label>
          <Input
            id={ids.token}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              tokenSaved ? 'Jeton enregistré : laissez vide pour le garder' : 'Facultatif'
            }
            value={token}
            aria-describedby={ids.tokenHint}
            onChange={(e) => {
              setToken(e.target.value);
              setResult(undefined);
            }}
          />
          <Hint id={ids.tokenHint}>
            Conservé chiffré dans le trousseau de votre Mac. Inutile pour un serveur local.
          </Hint>
        </div>

        <Button type="submit" variant="outline" disabled={testing}>
          {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {testing ? 'Test en cours…' : 'Tester la connexion'}
        </Button>
      </form>

      <div aria-live="polite">
        {result?.ok ? (
          <Alert tone="success" title="Connexion réussie">
            <ul className="space-y-0.5">
              {result.latencyMs !== undefined ? (
                <li>Temps de réponse : {result.latencyMs} ms</li>
              ) : null}
              {result.serverVersion ? <li>Version du serveur : {result.serverVersion}</li> : null}
              <li>
                {result.models.length === 0
                  ? 'Aucun modèle installé'
                  : `${String(result.models.length)} modèle${result.models.length > 1 ? 's' : ''} disponible${result.models.length > 1 ? 's' : ''}`}
              </li>
              {result.contextWindow !== undefined ? (
                <li>Contexte : {formatContext(result.contextWindow)}</li>
              ) : null}
            </ul>
          </Alert>
        ) : null}
        {result && !result.ok ? (
          <Alert tone="error" title="Connexion impossible">
            {result.errorCode ? errorMessage({ code: result.errorCode }) : 'Erreur inconnue.'}
          </Alert>
        ) : null}
        {saveError ? <Alert tone="error">{saveError}</Alert> : null}
      </div>
    </StepCard>
  );
}
