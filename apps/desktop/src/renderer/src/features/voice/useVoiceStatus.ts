/**
 * État de la voix (micro, moteur, modèles), lu par `voice:status` et tenu à
 * jour par les événements `voice:status` et `voice:model` (progression du
 * téléchargement comprise).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceModelInfo, VoiceStatus } from '@atelier/shared';
import { atelier, call } from '@renderer/lib/api';

function withModel(status: VoiceStatus, model: VoiceModelInfo): VoiceStatus {
  const known = status.models.some((m) => m.id === model.id);
  return {
    ...status,
    models: known
      ? status.models.map((m) => (m.id === model.id ? model : m))
      : [...status.models, model],
  };
}

/**
 * `eager` : lit l'état au montage (Réglages). Sinon, seulement au premier
 * `refresh()` (Composer : pas d'IPC tant que le micro n'est pas utilisé).
 */
export function useVoiceStatus({ eager = false }: { eager?: boolean } = {}): {
  status: VoiceStatus | undefined;
  refresh: () => Promise<VoiceStatus>;
} {
  const [status, setStatus] = useState<VoiceStatus | undefined>();
  const latest = useRef<VoiceStatus | undefined>(undefined);

  const update = useCallback((next: VoiceStatus) => {
    latest.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    const api = atelier();
    const offStatus = api.on('voice:status', update);
    const offModel = api.on('voice:model', (model) => {
      if (latest.current) update(withModel(latest.current, model));
    });
    return () => {
      offStatus();
      offModel();
    };
  }, [update]);

  const refresh = useCallback(async () => {
    const next = await call('voice:status');
    update(next);
    return next;
  }, [update]);

  useEffect(() => {
    if (!eager) return;
    call('voice:status').then(update, () => undefined);
  }, [eager, update]);

  return { status, refresh };
}
