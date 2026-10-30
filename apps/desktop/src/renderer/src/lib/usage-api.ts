/**
 * Lecture des statistiques d'utilisation (`usage:summary`, ADR-001).
 *
 * Seul point du renderer qui dépend du lot L0 : tant que le canal n'est pas dans
 * `IPC_INVOKE_CHANNELS` de `@atelier/shared`, le preload le refuse et la rubrique
 * affiche une erreur. Au merge de L0, ce corps devient `call('usage:summary', { period })`.
 */
import type { IpcResult } from '@atelier/shared';
import type { UsagePeriod, UsageSummary } from '../../../common/usage';
import { atelier, IpcError } from './api';

type UntypedInvoke = (channel: string, request: unknown) => Promise<IpcResult<UsageSummary>>;

export async function loadUsageSummary(period: UsagePeriod): Promise<UsageSummary> {
  const api = atelier();
  // Temporaire (avant L0) : rappelé avec `call(api, …)`, le `this` est conservé.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const invoke = api.invoke as unknown as UntypedInvoke;
  const result = await invoke.call(api, 'usage:summary', { period });
  if (!result.ok) throw new IpcError(result.error);
  return result.value;
}
