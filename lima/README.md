# lima/ : template et provisioning de la VM Atelier

Spécification : `docs/BRIEF.md` §3. Implémentation : `packages/sandbox` (`LimaSandbox`, interface `Sandbox` de `@atelier/shared`).

## Contenu

| Fichier                     | Rôle                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atelier.yaml`              | Template Lima : `vmType: vz`, `aarch64`, `virtiofs`, 4 CPU / 4 Gio / 30 Gio (surchargés par les Réglages), Ubuntu 26.04 LTS arm64 épinglée (URL + digest), aucun montage par défaut, seul le port 8888 forwardé. |
| `atelier.yaml` → provisions | À **chaque démarrage** : utilisateurs `agent` / `searxng`, scripts `atelier-network`, `atelier-exec`, `atelier-kill`, service `atelier-network` (réseau de `agent` coupé au boot), services inutiles désactivés. |
| `provision/10-packages.sh`  | python3, pip, venv, pandas, openpyxl, xlsxwriter, matplotlib, poppler-utils, pandoc, jq, ripgrep, git, sqlite3…                                                                                                  |
| `provision/20-node.sh`      | Node.js 22 (dépôt NodeSource), `exceljs` et `jszip` globaux (`NODE_PATH` dans `/etc/profile.d`).                                                                                                                 |
| `provision/30-searxng.sh`   | SearXNG (commit épinglé) dans un venv, servi par granian sous l'utilisateur `searxng`, JSON activé, `127.0.0.1:8888`.                                                                                            |

## Cycle de vie (piloté par `LimaSandbox`)

- `LIMA_HOME` = `~/Library/Application Support/Atelier/lima`, instance `atelier`. `limactl` est embarqué (`pnpm fetch:lima` → `apps/desktop/resources/lima/`, copié dans `Contents/Resources/lima`).
- **Premier lancement** : `limactl create` (template + ressources + montages) → `limactl start` (téléchargement de l'image ~600 Mo, boot) → provisioning lourd **piloté par l'hôte** : les scripts `provision/*.sh` sont concaténés et envoyés à `sudo bash -s` dans la VM. Ils émettent des marqueurs `::atelier:: <pourcentage> <message>` affichés dans la barre de progression. Une empreinte des scripts est écrite dans `/var/lib/atelier/provisioned` : on ne reprovisionne que si les scripts changent (mise à jour de l'app) ou après un échec (repris au lancement suivant).
  - Pourquoi pas tout en `mode: system` dans le template ? `limactl start` bloquerait sans progression lisible pendant 10 minutes, avec son propre délai d'attente, et un échec rendrait l'instance inutilisable. Le template ne garde que ce qui doit s'appliquer à chaque boot.
- **Changement de dossier** (`setWorkspace`) : `limactl stop` → `limactl edit --set '.mounts = [...]'` → `limactl start`. Rien n'est fait si le dossier ne change pas ; si la VM n'est pas démarrée, le dossier est appliqué au prochain `ensureReady` (pas de double redémarrage). La durée est mesurée (`diagnostics().extra.timings.lastWorkspaceSwitchMs`).
- **Refusés comme dossier de travail** : la racine, le `$HOME` complet (ou un de ses parents), `LIMA_HOME`, le dossier des skills.

## Exécution des commandes

```
limactl shell --workdir /workspace atelier -- sudo -u agent -H -- [env K=V…] atelier-exec <id> <délai-s> <commande>
```

`atelier-exec` lance `timeout --kill-after=5 <délai> bash -lc <commande>` dans son propre groupe de processus : au délai, **tout** le groupe est tué (y compris les processus en arrière-plan). L'annulation (bouton stop) appelle `atelier-kill <id>` en tant que `agent` (il ne peut tuer que ses propres processus). L'hôte garde une marge de 15 s avant de tuer `limactl` lui-même. Sortie tronquée à 10 ko (début + fin conservés).

## Réseau

`atelier-network on|off|status` (root) remplace atomiquement la table nftables `inet atelier` :

| État               | Règles pour `meta skuid "agent"`                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (par défaut) | loopback autorisé **sauf** DNS (53) et SearXNG (8888) ; tout le reste rejeté. Aucune donnée ne peut sortir, ni par requête DNS ni par une recherche. |
| `on`               | tout autorisé sauf la passerelle hôte `192.168.5.2` (qui donnerait accès aux services du Mac écoutant sur localhost).                                |

- `reject` plutôt que `drop` (brief : « `meta skuid agent drop` ») : même blocage, mais la commande échoue immédiatement au lieu d'attendre le délai de connexion de `curl`/`pip`, ce qui évite de bloquer l'agent 2 minutes.
- Fail-closed : la règle `off` est appliquée à chaque démarrage (service systemd avant `network-pre.target` + script de boot) ; l'app réapplique ensuite son choix.
- L'utilisateur `searxng` n'est jamais filtré.

## Montages

- `/workspace` : dossier de travail, en écriture (virtiofs). Les fichiers créés par `agent` appartiennent à l'utilisateur macOS côté hôte.
- `/skills` : `~/Atelier/skills`, en **lecture seule** (partage virtiofs read-only : garanti par l'hyperviseur).
- Aucun autre montage (le montage par défaut de `~` par Lima est désactivé : `mounts: []`).

## Mises à jour des versions épinglées

| Élément        | Où                                                      | Comment                                                                                                                 |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lima           | `scripts/fetch-lima.ts` (`LIMA_VERSION`, `LIMA_SHA256`) | SHA-256 de `lima-<v>-Darwin-arm64.tar.gz` dans le `SHA256SUMS` de la release ; `pnpm fetch:lima --force`.               |
| Image Ubuntu   | `atelier.yaml` (`images`)                               | Reprendre l'entrée `aarch64` datée de `templates/_images/ubuntu-26.04.yaml` de la release Lima utilisée (URL + digest). |
| SearXNG        | `provision/30-searxng.sh` (`SEARXNG_COMMIT`)            | Commit de `master` testé ; modifier un script de provisioning déclenche un reprovisioning au lancement suivant.         |
| Node / exceljs | `provision/20-node.sh`                                  | `NODE_MAJOR`, `EXCELJS_VERSION`, `JSZIP_VERSION`.                                                                       |

## Dépannage

```bash
export LIMA_HOME="$HOME/Library/Application Support/Atelier/lima"
apps/desktop/resources/lima/bin/limactl list
apps/desktop/resources/lima/bin/limactl shell atelier            # shell (utilisateur macOS, sudo)
apps/desktop/resources/lima/bin/limactl shell atelier -- sudo nft list table inet atelier
apps/desktop/resources/lima/bin/limactl shell atelier -- sudo journalctl -u searxng -n 50
tail -f "$LIMA_HOME/atelier/ha.stderr.log"                       # journal de l'hôte Lima
```

Tests d'intégration (VM réelle, instance `atelier-it` dans un `LIMA_HOME` séparé) :

```bash
pnpm fetch:lima
ATELIER_SANDBOX_IT=1 pnpm --filter @atelier/sandbox test lima.integration
```
