/**
 * Classification des adresses IP : `web_fetch` refuse tout ce qui n'est pas une
 * adresse publique routable (loopback, réseaux privés, lien local, CGNAT,
 * métadonnées cloud, multicast, réservées…), y compris sous forme IPv6
 * (IPv4 mappée, NAT64, 6to4).
 */
import { BlockList, isIP } from 'node:net';

const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // « ce réseau »
  ['10.0.0.0', 8], // privé
  ['100.64.0.0', 10], // CGNAT (et Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // lien local (métadonnées cloud)
  ['172.16.0.0', 12], // privé
  ['192.0.0.0', 24], // IETF
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // relais 6to4
  ['192.168.0.0', 16], // privé
  ['198.18.0.0', 15], // bancs de test
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // réservé + broadcast
];

const BLOCKED_V6: readonly [string, number][] = [
  ['::', 128], // non spécifiée
  ['::1', 128], // loopback
  ['100::', 64], // jetable
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // ULA (privé)
  ['fe80::', 10], // lien local
  ['fec0::', 10], // site local (obsolète)
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, 'ipv6');

/** Développe une adresse IPv6 en 8 groupes de 16 bits. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // Suffixe IPv4 (ex. ::ffff:127.0.0.1) → deux groupes hexadécimaux.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1] !== undefined) {
    const bytes = v4[1].split('.').map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    text =
      text.slice(0, -v4[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? undefined : groups;
}

function v4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Adresse IPv4 encapsulée dans une adresse IPv6 (mappée `::ffff:a.b.c.d`,
 * compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), sinon `undefined`.
 */
export function embeddedIpv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g) return undefined;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && (g5 === 0xffff || g5 === 0) && (g6 !== 0 || g7 > 1))
    return v4FromGroups(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4FromGroups(g6, g7);
  }
  if (g0 === 0x2002) return v4FromGroups(g1, g2);
  return undefined;
}

/**
 * Vrai si l'adresse IP ne doit jamais être contactée par `web_fetch`.
 * Une valeur qui n'est pas une adresse IP valide est considérée comme bloquée.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split('%')[0] ?? '');
  if (family === 4) return blockList.check(address, 'ipv4');
  if (family !== 6) return true;
  const v4 = embeddedIpv4(address);
  if (v4 !== undefined) return blockList.check(v4, 'ipv4');
  return blockList.check(address.split('%')[0] ?? address, 'ipv6');
}
