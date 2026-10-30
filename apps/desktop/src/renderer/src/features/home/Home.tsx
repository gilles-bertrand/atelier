/**
 * Accueil : choisir le dossier de travail d'une nouvelle conversation. Les
 * conversations existantes sont dans la colonne de gauche.
 */
import { useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { AtelierMark } from '@renderer/components/AtelierMark';
import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';

export function Home({ onChooseFolder }: { onChooseFolder: () => Promise<void> }) {
  const { state } = useApp();
  const { sidebarOpen } = useShellChrome();
  const [choosing, setChoosing] = useState(false);

  const chooseFolder = async (): Promise<void> => {
    setChoosing(true);
    try {
      await onChooseFolder();
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex flex-1 items-center [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
        </div>
        <ServerStatusBadge status={state.server} className="[-webkit-app-region:no-drag]" />
      </header>
      <main className="flex flex-1 items-center overflow-y-auto">
        <section className="mx-auto w-full max-w-xl space-y-4 px-6 py-12 text-center">
          <AtelierMark className="mx-auto block size-14" />
          <h1 className="text-2xl font-semibold tracking-tight">Sur quoi travaille-t-on ?</h1>
          <p className="text-sm text-muted-foreground">
            Choisissez le dossier qui contient vos documents. L’assistant pourra les lire, en créer
            de nouveaux et les modifier avec votre accord.
          </p>
          <Button size="lg" onClick={() => void chooseFolder()} disabled={choosing}>
            {choosing ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <FolderPlus className="size-4" aria-hidden />
            )}
            Choisir un dossier
          </Button>
        </section>
      </main>
    </div>
  );
}
