import { describe, expect, it } from 'vitest';
import { embeddedIpv4, isBlockedAddress, parseFetchableUrl } from '../src/index.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // métadonnées cloud
    '100.100.100.100', // CGNAT / Tailscale
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%en0',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '2002:c0a8:0101::1', // 6to4 → 192.168.1.1
    'pas-une-ip',
  ])('refuse %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepte %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('extrait l’IPv4 encapsulée', () => {
    expect(embeddedIpv4('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(embeddedIpv4('2002:0a00:0001::')).toBe('10.0.0.1');
    expect(embeddedIpv4('2606:4700::1')).toBeUndefined();
  });
});

describe('parseFetchableUrl', () => {
  it('accepte http et https', () => {
    expect(parseFetchableUrl('https://example.com/a').hostname).toBe('example.com');
    expect(parseFetchableUrl(' http://example.com ').protocol).toBe('http:');
  });

  it.each(['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,x'])(
    'refuse le schéma de %s',
    (url) => {
      expect(() => parseFetchableUrl(url)).toThrow(/Schéma refusé/);
    },
  );

  it('refuse les identifiants et les URL invalides', () => {
    expect(() => parseFetchableUrl('https://user:pw@example.com')).toThrow(/identifiants/);
    expect(() => parseFetchableUrl('pas une url')).toThrow(/URL invalide/);
  });
});
