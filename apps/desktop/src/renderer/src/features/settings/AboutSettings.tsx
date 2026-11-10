/** Réglages › À propos et licences (#43) : licence de YodAI, charte acceptée, composants tiers. */
import { useApp } from '@renderer/state/app-state';
import { LegalText } from '../legal/LegalText';
import {
  APP_LICENSE_TEXT,
  CHARTER_TEXT,
  OPENRAIL_M_TEXT,
  THIRD_PARTY_NOTICES,
} from '../legal/texts';
import { SettingsSection } from './common';

function acceptedOn(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function AboutSettings() {
  const { state } = useApp();
  const accepted = acceptedOn(state.settings.charterAcceptedAt);
  return (
    <>
      <SettingsSection
        title="Licence de YodAI"
        description="Functional Source License 1.1 (FSL-1.1-ALv2), Triptyk. Le code est consultable ; il ne peut pas être revendu ni servir à un produit concurrent. Chaque version passe sous licence Apache 2.0 deux ans après sa publication."
      >
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Texte de la licence (anglais)
          </summary>
          <LegalText text={APP_LICENSE_TEXT} label="Licence de YodAI" className="mt-3" />
        </details>
      </SettingsSection>

      <SettingsSection
        title="Charte d’usage"
        description={accepted ? `Acceptée le ${accepted}.` : undefined}
      >
        <LegalText text={CHARTER_TEXT} label="Charte d’usage" />
      </SettingsSection>

      <SettingsSection
        title="Composants et modèles tiers"
        description="Chacun garde sa propre licence. Les licences de Chromium sont livrées avec l’app (LICENSES.chromium.html)."
      >
        <ul className="divide-y rounded-lg border text-sm">
          {THIRD_PARTY_NOTICES.map((n) => (
            <li key={n.name} className="space-y-0.5 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{n.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {n.license}
                </span>
              </div>
              <p className="text-muted-foreground">{n.role}</p>
              {n.attribution ? (
                <p className="text-xs text-muted-foreground">{n.attribution}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Licence BigScience OpenRAIL-M de Supertonic 3 (anglais)
          </summary>
          <LegalText
            text={OPENRAIL_M_TEXT}
            label="Licence OpenRAIL-M de Supertonic 3"
            plain
            className="mt-3"
          />
        </details>
      </SettingsSection>
    </>
  );
}
