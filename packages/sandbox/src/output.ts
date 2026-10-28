/**
 * Capture bornée de la sortie d'un processus : on garde le début et la fin
 * (les erreurs sont souvent en fin de sortie), jamais plus de `capacity` octets
 * de chaque côté, quelle que soit la taille réelle de la sortie.
 */

/** Taille de sortie renvoyée par défaut (brief : 10 ko). */
export const DEFAULT_MAX_OUTPUT_BYTES = 10_240;

/** Collecte un flux d'octets en ne gardant que sa tête et sa queue. */
export class OutputCollector {
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly capacity: number) {}

  /** Nombre total d'octets reçus. */
  get size(): number {
    return this.total;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < this.capacity) {
      const room = this.capacity - this.head.length;
      this.head = Buffer.concat([this.head, chunk.subarray(0, room)]);
    }
    const merged = Buffer.concat([this.tail, chunk]);
    this.tail =
      merged.length > this.capacity ? merged.subarray(merged.length - this.capacity) : merged;
  }

  /**
   * Rend le texte en au plus `budget` octets (≤ capacité) : intégral s'il tient,
   * sinon tête + marqueur + queue.
   */
  render(budget: number = this.capacity): { text: string; truncated: boolean } {
    const limit = Math.max(0, Math.min(budget, this.capacity));
    if (this.total <= limit) return { text: this.head.toString('utf8'), truncated: false };
    const headBytes = Math.floor(limit / 2);
    const tailBytes = limit - headBytes;
    const head = utf8Head(this.head.subarray(0, headBytes));
    const tail = utf8Tail(this.tail.subarray(Math.max(0, this.tail.length - tailBytes)));
    const skipped = this.total - head.length - tail.length;
    return {
      text: `${head.toString('utf8')}\n[… ${String(skipped)} octets tronqués …]\n${tail.toString('utf8')}`,
      truncated: true,
    };
  }
}

/** Retire un caractère UTF-8 incomplet en fin de tampon. */
function utf8Head(buf: Buffer): Buffer {
  let end = buf.length;
  // Remonte jusqu'à 3 octets de continuation (10xxxxxx) pour trouver le début du caractère.
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && ((buf[i] ?? 0) & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i >= 0) {
    const lead = buf[i] ?? 0;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (expected > continuation + 1) end = i;
  }
  return buf.subarray(0, end);
}

/** Retire les octets de continuation UTF-8 orphelins en début de tampon. */
function utf8Tail(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && start < 3 && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/**
 * Répartit un budget d'octets entre stdout et stderr : stderr garde au moins
 * un quart du budget s'il en a besoin, stdout prend le reste.
 */
export function splitOutputBudget(
  stdoutBytes: number,
  stderrBytes: number,
  budget: number,
): { stdout: number; stderr: number } {
  if (stdoutBytes + stderrBytes <= budget) return { stdout: stdoutBytes, stderr: stderrBytes };
  const stderr = Math.min(stderrBytes, Math.max(budget - stdoutBytes, Math.floor(budget / 4)));
  return { stdout: budget - stderr, stderr };
}
