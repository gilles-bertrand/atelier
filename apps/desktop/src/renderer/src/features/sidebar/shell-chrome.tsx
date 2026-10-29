/**
 * Lien entre la colonne de gauche et l'en-tête des vues : quand la colonne est
 * masquée, l'en-tête laisse la place aux boutons de fenêtre macOS et affiche le
 * bouton ⇥ pour la rouvrir.
 */
import { createContext, use, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';

export interface ShellChrome {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

const ShellChromeContext = createContext<ShellChrome>({
  sidebarOpen: false,
  toggleSidebar: () => undefined,
});

export function ShellChromeProvider({
  value,
  children,
}: {
  value: ShellChrome;
  children: ReactNode;
}) {
  return <ShellChromeContext value={value}>{children}</ShellChromeContext>;
}

export function useShellChrome(): ShellChrome {
  return use(ShellChromeContext);
}

/**
 * Marge gauche d'un en-tête de vue : la colonne porte les boutons de fenêtre
 * quand elle est ouverte, sinon l'en-tête doit les éviter.
 */
export function headerInset(sidebarOpen: boolean): string {
  return sidebarOpen ? 'pl-4' : 'pl-20';
}

/** Bouton ⇥ de l'en-tête, visible seulement quand la colonne est masquée. */
export function SidebarOpenButton() {
  const { sidebarOpen, toggleSidebar } = useShellChrome();
  if (sidebarOpen) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Afficher la barre latérale"
      title="Afficher la barre latérale (⌘B)"
      onClick={toggleSidebar}
      className="shrink-0"
    >
      <PanelLeftOpen className="size-4" aria-hidden />
    </Button>
  );
}
