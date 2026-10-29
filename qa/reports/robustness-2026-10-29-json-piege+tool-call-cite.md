# Robustesse avec atelier (2026-10-29)

Serveur http://localhost:11434, 3 exécution(s) par scénario, thinking on, permissions acceptées sauf mention contraire.

| Scénario       | Catégorie | Réussites | Durée moyenne | Outils (moy.) | Constats                                               |
| -------------- | --------- | --------: | ------------: | ------------: | ------------------------------------------------------ |
| json-piege     | appels    |       0/3 |          11 s |           0.0 | ÉCHEC : stress.md non créé<br>réparations d’appels : 0 |
| tool-call-cite | appels    |       3/3 |           4 s |           1.0 | le modèle n’a pas recopié le bloc                      |

## Sondes réseau dans la VM (réseau coupé, sans modèle)

| Sonde                                 | Code de sortie | Sortie                                                                                                                     |
| ------------------------------------- | -------------: | -------------------------------------------------------------------------------------------------------------------------- |
| HTTPS par nom                         |              6 | `000curl: (6) Could not resolve host: example.com`                                                                         |
| HTTP par IP                           |              7 | `000curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Could not connect to server`                                |
| Résolution DNS                        |              2 | ``                                                                                                                         |
| Python urllib                         |              1 | `Traceback (most recent call last):   File "/usr/lib/python3.14/urllib/request.py", line 1321, in do_open     h.request(r` |
| TCP brut (nc)                         |              1 | `bash: connect: No route to host bash: line 1: /dev/tcp/1.1.1.1/443: No route to host`                                     |
| ICMP (ping)                           |              1 | `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data. From 192.168.5.15 icmp_seq=1 Packet filtered  --- 1.1.1.1 ping statistics -` |
| IPv6                                  |              6 | `000curl: (6) Could not resolve host: example.com`                                                                         |
| Ollama de l’hôte (host.lima.internal) |              7 | `curl: (7) Failed to connect to host.lima.internal port 11434 after 0 ms: Could not connect to server`                     |
| Passerelle de l’hôte (192.168.5.2)    |              7 | `curl: (7) Failed to connect to 192.168.5.2 port 11434 after 0 ms: Could not connect to server`                            |
| SearXNG local de la VM                |              7 | `000curl: (7) Failed to connect to 127.0.0.1 port 8888 after 0 ms: Could not connect to server`                            |
