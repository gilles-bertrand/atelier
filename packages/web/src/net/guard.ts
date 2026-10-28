/**
 * Garde réseau de `web_fetch` : schéma http(s) uniquement, pas d'identifiants
 * dans l'URL, et aucune adresse non publique (IP littérale ou résolue par DNS).
 *
 * La vérification a lieu deux fois : avant la requête (message clair) et au
 * moment de la connexion TCP via {@link createGuardedLookup} (protection contre
 * le DNS rebinding et les redirections vers le réseau local).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { AtelierError } from '@atelier/shared';
import { isBlockedAddress } from './address.js';

/** Résolution DNS injectable : renvoie toutes les adresses d'un nom d'hôte. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Résolution par défaut (`dns.lookup`, toutes familles). */
export const defaultResolveHost: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => a.address));
    });
  });

/** Nom d'hôte sans crochets IPv6 (`[::1]` → `::1`). */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * Valide la forme de l'URL (schéma, identifiants) sans réseau.
 * @throws AtelierError `web/blocked_address` (schéma refusé) ou `tool/invalid_input`.
 */
export function parseFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AtelierError('tool/invalid_input', `URL invalide : ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AtelierError(
      'web/blocked_address',
      `Schéma refusé (${url.protocol}) : seules les URL http et https sont autorisées.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new AtelierError(
      'web/blocked_address',
      "Les identifiants dans l'URL ne sont pas autorisés.",
    );
  }
  if (url.hostname === '') throw new AtelierError('tool/invalid_input', `URL sans hôte : ${raw}`);
  return url;
}

/**
 * Vérifie que l'hôte de l'URL ne désigne que des adresses publiques.
 * @throws AtelierError `web/blocked_address` ou `web/fetch_failed` (DNS en échec).
 */
export async function assertPublicHost(url: URL, resolveHost: ResolveHost): Promise<void> {
  const host = bareHostname(url);
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch (error) {
      throw new AtelierError('web/fetch_failed', `Nom de domaine introuvable : ${host}`, {
        retryable: true,
        cause: error,
      });
    }
    if (addresses.length === 0) {
      throw new AtelierError('web/fetch_failed', `Nom de domaine introuvable : ${host}`);
    }
  }
  const blocked = addresses.find(isBlockedAddress);
  if (blocked !== undefined) {
    throw new AtelierError(
      'web/blocked_address',
      `Adresse refusée : ${host} pointe vers une adresse locale ou privée (${blocked}).`,
      { details: { host, address: blocked } },
    );
  }
}

/**
 * `lookup` pour `net.connect` (undici) qui refuse les adresses non publiques au
 * moment même de la connexion.
 */
export function createGuardedLookup(): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const blocked = addresses.find((a) => isBlockedAddress(a.address));
      if (blocked) {
        const refusal = new AtelierError(
          'web/blocked_address',
          `Adresse refusée : ${hostname} pointe vers une adresse locale ou privée (${blocked.address}).`,
        );
        callback(refusal, '', 0);
        return;
      }
      if (options.all === true) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
        return;
      }
      const first = addresses[0];
      if (!first) {
        callback(new Error(`Aucune adresse pour ${hostname}`), '', 0);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}
