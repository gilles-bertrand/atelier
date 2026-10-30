/** Recherche web : fournisseur et clés d'API (chiffrées, jamais relues par l'écran). */
import { useId, useState } from 'react';
import type { SearchProviderId } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label } from '@renderer/components/ui/primitives';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { FeedbackLine, SettingsSection, useAction } from './common';

const PROVIDERS: { id: SearchProviderId; label: string; hint: string }[] = [
  {
    id: 'searxng',
    label: 'SearXNG (intégré)',
    hint: 'Moteur méta installé dans la machine isolée. Aucune clé, mais la machine doit être prête.',
  },
  { id: 'brave', label: 'Brave Search', hint: 'Service en ligne, clé d’API requise.' },
  {
    id: 'ollama',
    label: 'Ollama Web Search',
    hint: 'Service en ligne d’Ollama, clé d’API requise.',
  },
];

function KeyField({
  id: secretId,
  label,
}: {
  id: 'brave_search_key' | 'ollama_search_key';
  label: string;
}) {
  const { state, actions } = useApp();
  const inputId = useId();
  const [value, setValue] = useState('');
  const action = useAction();
  const present = state.secrets[secretId];
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>
        {label}
        {present ? (
          <span className="ml-2 text-xs font-normal text-success-text">configurée</span>
        ) : null}
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          placeholder={present ? 'Clé enregistrée' : 'Collez la clé'}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
        <Button
          variant="outline"
          disabled={action.busy || value.trim() === ''}
          onClick={() =>
            void action.run(async () => {
              await actions.setSecret(secretId, value.trim());
              setValue('');
            }, 'Clé enregistrée.')
          }
        >
          Enregistrer
        </Button>
        {present ? (
          <Button
            variant="ghost"
            disabled={action.busy}
            onClick={() => void action.run(() => actions.setSecret(secretId, null), 'Clé effacée.')}
          >
            Effacer
          </Button>
        ) : null}
      </div>
      <FeedbackLine feedback={action.feedback} />
    </div>
  );
}

export function SearchSettings() {
  const { state, actions } = useApp();
  const action = useAction();
  const current = state.settings.search.provider;
  const missingKey =
    (current === 'brave' && !state.secrets.brave_search_key) ||
    (current === 'ollama' && !state.secrets.ollama_search_key);

  return (
    <SettingsSection
      title="Recherche web"
      description="Les questions de recherche partent vers ce service ; le contenu de vos fichiers, jamais."
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Fournisseur</legend>
        {PROVIDERS.map((p) => (
          <label
            key={p.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              current === p.id ? 'border-primary bg-accent' : 'hover:bg-accent/60',
            )}
          >
            <input
              type="radio"
              name="search-provider"
              value={p.id}
              checked={current === p.id}
              disabled={action.busy}
              onChange={() =>
                void action.run(() => actions.updateSettings({ search: { provider: p.id } }))
              }
              className="mt-0.5 size-4 accent-brand"
            />
            <span>
              <span className="font-medium">{p.label}</span>
              <span className="block text-xs text-muted-foreground">{p.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FeedbackLine feedback={action.feedback} />
      {missingKey ? (
        <Alert tone="warning">Ce fournisseur a besoin d’une clé : renseignez-la ci-dessous.</Alert>
      ) : null}
      <Hint>
        Si le fournisseur choisi est indisponible, Atelier essaie automatiquement les autres
        fournisseurs dont la clé est configurée.
      </Hint>
      <KeyField id="brave_search_key" label="Clé Brave Search" />
      <KeyField id="ollama_search_key" label="Clé Ollama Web Search" />
    </SettingsSection>
  );
}
