/**
 * Briques de la dictée partagées par le Composer et Réglages › Voix :
 * vu-mètre, carte du modèle (téléchargement avec progression), alertes.
 */
import { Download, Loader2, Settings2 } from 'lucide-react';
import type { SerializedAtelierError, VoiceModelInfo } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Progress } from '@renderer/components/ui/primitives';
import { call } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatBytes } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { approxDownloadSize, downloadRatio } from '@renderer/lib/voice';

/** Vu-mètre : niveau du micro calculé dans le renderer (D3). Décoratif pour VoiceOver. */
export function LevelMeter({ level, className }: { level: number; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
  return (
    <span
      aria-hidden
      data-testid="voice-level"
      className={cn('block h-1.5 w-12 overflow-hidden rounded-full bg-muted', className)}
    >
      <span
        className="block h-full rounded-full bg-destructive transition-[width] duration-100"
        style={{ width: `${String(percent)}%` }}
      />
    </span>
  );
}

/** Message d'une erreur de dictée (aucun micro : message dédié). */
export function voiceErrorText(error: SerializedAtelierError): string {
  if (error.code === 'voice/no_input' && error.details?.['reason'] === 'no_device') {
    return 'Aucun micro n’est disponible. Branchez-en un, ou choisissez-en un autre dans Réglages › Voix.';
  }
  return errorMessage(error);
}

/** Micro refusé par macOS : lien vers Réglages Système › Confidentialité et sécurité › Micro. */
export function MicDeniedAlert({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <Alert tone="error" title="Micro refusé">
      <p>
        YodAI n’a pas accès au micro. Autorisez-le dans Réglages Système › Confidentialité et
        sécurité › Micro, puis réessayez.
      </p>
      <span className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            call('voice:open-mic-settings').catch(() => undefined);
          }}
        >
          <Settings2 className="size-3.5" aria-hidden />
          Ouvrir Réglages Système › Micro
        </Button>
        {onDismiss ? (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Fermer
          </Button>
        ) : null}
      </span>
    </Alert>
  );
}

/** Ligne de progression d'un téléchargement : « 120 Mo sur 464 Mo ». */
export function ModelProgress({ model }: { model: VoiceModelInfo }) {
  const ratio = downloadRatio(model);
  return (
    <div className="space-y-1.5">
      <Progress value={ratio} label={`Téléchargement de ${model.label}`} />
      {model.progress ? (
        <p className="text-xs text-muted-foreground">
          {formatBytes(model.progress.receivedBytes)} sur {formatBytes(model.progress.totalBytes)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Carte du premier usage : le modèle de reconnaissance manque (ou est
 * endommagé) ; téléchargement avec progression et annulation.
 */
export function ModelDownloadCard({
  model,
  busy,
  onDownload,
  onCancelDownload,
  onDismiss,
}: {
  model: VoiceModelInfo | undefined;
  busy: boolean;
  onDownload: () => void;
  onCancelDownload: () => void;
  onDismiss: () => void;
}) {
  const size = approxDownloadSize(model?.downloadBytes ?? 490_000_000);
  const downloading = model?.state === 'downloading';
  const ready = model?.state === 'installed' || model?.state === 'loaded';
  return (
    <section
      aria-label="Modèle de reconnaissance vocale"
      className="space-y-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
    >
      {ready ? (
        <p role="status">Modèle installé. Cliquez sur le micro pour dicter.</p>
      ) : (
        <p>
          La dictée a besoin du modèle de reconnaissance ({size}, téléchargé une fois, traité sur ce
          Mac).
        </p>
      )}
      {model?.state === 'error' && model.error ? (
        <Alert tone="error">{errorMessage(model.error)}</Alert>
      ) : null}
      {downloading ? <ModelProgress model={model} /> : null}
      <div className="flex flex-wrap gap-2">
        {downloading ? (
          <Button size="sm" variant="outline" onClick={onCancelDownload}>
            Annuler le téléchargement
          </Button>
        ) : ready ? (
          <Button size="sm" variant="outline" onClick={onDismiss}>
            Fermer
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={onDownload} disabled={busy || model === undefined}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="size-3.5" aria-hidden />
              )}
              {model?.state === 'error' ? 'Réessayer' : 'Télécharger'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Plus tard
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
