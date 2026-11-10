/**
 * Textes légaux, embarqués tels quels dans le renderer (#43). La source est
 * dans le dépôt : `docs/legal/CHARTE.md` (charte d'usage), `LICENSE.md`
 * (FSL-1.1-ALv2) et le texte OpenRAIL-M de Supertonic 3.
 */
import appLicense from '../../../../../../../LICENSE.md?raw';
import charter from '../../../../../../../docs/legal/CHARTE.md?raw';
import openRailM from '../../../../../../../docs/legal/OpenRAIL-M-Supertonic-3.txt?raw';

export const CHARTER_TEXT = charter;
export const APP_LICENSE_TEXT = appLicense;
export const OPENRAIL_M_TEXT = openRailM;

/** Composant ou modèle tiers, avec sa licence (Réglages › À propos et licences). */
export interface ThirdPartyNotice {
  name: string;
  role: string;
  license: string;
  attribution?: string;
}

/**
 * Principaux composants et modèles livrés avec YodAI. Les licences de
 * Chromium et de ses dépendances sont livrées par Electron
 * (`LICENSES.chromium.html`, dans le paquet de l'app).
 */
export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = [
  { name: 'Electron', role: 'Application de bureau', license: 'MIT' },
  { name: 'React', role: 'Interface', license: 'MIT' },
  { name: 'AI SDK (Vercel)', role: 'Dialogue avec le modèle', license: 'Apache-2.0' },
  { name: 'Model Context Protocol SDK', role: 'Connecteurs', license: 'MIT' },
  { name: 'Lima', role: 'Machine isolée', license: 'Apache-2.0' },
  { name: 'sherpa-onnx', role: 'Moteur de la voix', license: 'Apache-2.0' },
  { name: 'ONNX Runtime', role: 'Moteur de la voix', license: 'MIT' },
  { name: 'Silero VAD', role: 'Détection de parole', license: 'MIT' },
  {
    name: 'Parakeet TDT 0.6B v3 (NVIDIA)',
    role: 'Reconnaissance vocale (dictée)',
    license: 'CC-BY-4.0',
    attribution:
      'Modèle de NVIDIA, sous licence CC BY 4.0, converti en int8 par le projet sherpa-onnx.',
  },
  {
    name: 'Supertonic 3 (Supertone)',
    role: 'Voix de synthèse (mode conversation, à venir)',
    license: 'OpenRAIL-M',
    attribution:
      'Modèle de Supertone, sous licence BigScience OpenRAIL-M, quantifié en int8 par le projet sherpa-onnx (fichiers modifiés). Restrictions d’usage : annexe A, reprises dans la charte.',
  },
  { name: 'sharp / libvips', role: 'Images', license: 'Apache-2.0 / LGPL-3.0' },
];
