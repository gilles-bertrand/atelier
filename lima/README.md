# lima/ : template et provisioning de la VM Atelier

> Dossier réservé à l'**agent Sandbox** (branche `feat/sandbox-*`). Il est vide dans le squelette.
> Spécification : `docs/BRIEF.md` §3. Interface à implémenter : `Sandbox` dans `packages/shared/src/sandbox.ts`.

## Contenu attendu

| Fichier                | Rôle                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atelier.yaml`         | Template Lima : `vmType: vz`, `arch: aarch64`, `mountType: virtiofs`, 4 CPU / 4 Go par défaut (surchargés par les Réglages), image Ubuntu LTS arm64 épinglée (URL + digest)     |
| `provision/*.sh`       | Scripts de provisioning idempotents (`mode: system`) : python3, pip, node 22, exceljs, pandas, openpyxl, poppler-utils, outils CLI courants ; utilisateurs `agent` et `searxng` |
| `provision/searxng.sh` | SearXNG en service systemd sous l'utilisateur `searxng`, format JSON activé, sur le port 8888 (forwardé vers `127.0.0.1:8888` sur l'hôte)                                       |
| `provision/network.sh` | Règle nftables `meta skuid agent drop` en sortie (réseau coupé par défaut pour `agent`, sans impact sur `searxng`)                                                              |

## Contraintes

- **Mounts** : le dossier de travail en écriture sur `/workspace`, le dossier skills en lecture seule sur `/skills`. Jamais le `$HOME` complet (désactiver le mount par défaut de Lima).
- **Exec** : `limactl shell --workdir /workspace atelier -- sudo -u agent bash -lc <cmd>`.
- **LIMA_HOME** : `~/Library/Application Support/Atelier/lima` ; `limactl` est embarqué dans `Contents/Resources/lima` (voir `scripts/fetch-lima.ts` et `apps/desktop/electron-builder.yml`, qui copie aussi ce dossier dans `Contents/Resources/lima-templates`).
- Changement de dossier en moins de 15 s (mesure à reporter dans `docs/STATUS.md`).
- Port forwarding limité au 8888 (SearXNG) ; aucun autre port invité exposé.
