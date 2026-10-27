/** Écran vide du squelette : l'UI réelle est livrée par l'agent UI (feat/ui-*). */
export function App() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">Atelier</h1>
      <p className="text-sm text-muted-foreground">Votre assistant local. Bientôt prêt.</p>
    </main>
  );
}
