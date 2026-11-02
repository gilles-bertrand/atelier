/**
 * Fabrique d'archives tar (ustar) en mémoire, pour les tests : permet d'écrire
 * des entrées que `tar` refuserait de créer (`../`, liens symboliques…).
 */
export interface TarEntry {
  name: string;
  data?: string | Uint8Array;
  /** '0' fichier, '5' dossier, '2' lien symbolique, '1' lien physique. */
  type?: '0' | '1' | '2' | '5';
  linkname?: string;
}

function field(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

export function makeTar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? (entry.name.endsWith('/') ? '5' : '0');
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : typeof entry.data === 'string'
          ? Buffer.from(entry.data)
          : Buffer.from(entry.data);
    const size = type === '0' ? data.length : 0;
    const header = Buffer.alloc(512);
    field(header, 0, 100, entry.name);
    field(header, 100, 8, octal(type === '5' ? 0o755 : 0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(size, 12));
    field(header, 136, 12, octal(1_700_000_000, 12));
    header.fill(' ', 148, 156);
    field(header, 156, 1, type);
    if (entry.linkname) field(header, 157, 100, entry.linkname);
    field(header, 257, 6, 'ustar\0');
    field(header, 263, 2, '00');
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header);
    if (size > 0) {
      blocks.push(data);
      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
