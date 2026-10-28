# @atelier/web

Outils `web_search` et `web_fetch` d'Atelier (brief §4). Tout s'exécute côté hôte (process main).

## Branchement dans l'app

```ts
import { createSearchProvider, createWebTools } from '@atelier/web';
import { createDefaultRegistry } from '@atelier/agent-core';

const getApiKey = (p: 'ollama' | 'brave') =>
  secrets.get(p === 'ollama' ? 'ollama_search_key' : 'brave_search_key');
const provider = () => createSearchProvider(settings.search.provider, { getApiKey });
// Repli tant que la VM (SearXNG) n'est pas prête : les fournisseurs à clé configurés.
const fallbacks = () => [
  createSearchProvider('brave', { getApiKey }),
  createSearchProvider('ollama', { getApiKey }),
];

const registry = createDefaultRegistry([...createWebTools({ provider, fallbacks })]);
```

## `web_search({ query, max_results = 5 })`

- Permission : aucune.
- Fournisseurs (`SearchProvider` de `@atelier/shared`) :
  - `searxng` (défaut) : `GET http://127.0.0.1:8888/search?q=…&format=json`, servi par la VM Lima ; `isAvailable()` interroge `/healthz` (2 s) ;
  - `ollama` : `POST https://ollama.com/api/web_search`, `Authorization: Bearer <clé>` ;
  - `brave` : `GET https://api.search.brave.com/res/v1/web/search`, en-tête `X-Subscription-Token`.
- Résultats normalisés `{ title, url, snippet }` : URL http(s) uniquement, dédoublonnés, HTML retiré, 10 au maximum.
- Fournisseur indisponible (`web/search_unavailable` : VM pas prête, clé absente ou refusée) : les `fallbacks` sont essayés dans l'ordre, sinon le modèle reçoit « Recherche indisponible, configure Brave ou Ollama dans les Réglages d'Atelier ».
- Affichage UI : `{ type: 'web_results', results }`.

## `web_fetch({ url })`

- Permission `conditional` : demandée une fois par domaine (`scopeKey: web_fetch:<domaine>`, `www.` retiré, `kind: 'network'`). Un gestionnaire en échec vaut refus. Une redirection vers un autre domaine redemande la permission pour ce domaine (refus → `denied`). Le délai de 20 s est suspendu pendant la modale (le bouton stop reste actif).
- http(s) uniquement, pas d'identifiants dans l'URL.
- Adresses refusées : loopback, privées (RFC 1918, ULA), lien local (dont `169.254.169.254`), CGNAT/Tailscale, multicast, réservées, documentation, y compris sous forme IPv6 (IPv4 mappée, NAT64, 6to4). Vérification avant la requête, à chaque redirection (5 au maximum, suivies à la main) et **à la connexion TCP** (lookup filtré du dispatcher undici : protège du DNS rebinding).
- Délai 20 s, 5 Mo téléchargés au maximum, User-Agent `Atelier/0.1`.
- HTML → `@mozilla/readability` + `jsdom` (aucun script exécuté, aucune ressource chargée) → markdown (`turndown`, liens absolus, images remplacées par leur texte alternatif). Texte, JSON et XML passés tels quels ; autres types refusés (PDF : à télécharger puis lire avec `read_file`).
- Sortie tronquée à 20 ko avec un marqueur explicite. Affichage UI : `{ type: 'web_page', url, title }`.

## Tests

`pnpm --filter @atelier/web test` : providers mockés avec msw, extraction sur `test/fixtures/article.html`, garde à la connexion contre un vrai serveur local (`test/guard.test.ts`).
