import { describe, expect, it } from 'vitest';
import { chooseVm } from './vm-instance.js';

describe('chooseVm (ticket #41)', () => {
  it('app normale : la VM atelier, quelle que soit la variable', () => {
    expect(chooseVm({ userDataDirImposed: false, requested: undefined })).toEqual({
      kind: 'lima',
      instanceName: 'atelier',
    });
    expect(chooseVm({ userDataDirImposed: false, requested: 'atelier-e2e' })).toEqual({
      kind: 'lima',
      instanceName: 'atelier',
    });
  });

  it('instance de test : pas de VM par défaut, avec la marche à suivre', () => {
    for (const requested of [undefined, '', '  ']) {
      const choice = chooseVm({ userDataDirImposed: true, requested });
      expect(choice.kind).toBe('disabled');
      if (choice.kind === 'disabled') expect(choice.reason).toContain('ATELIER_VM_INSTANCE=');
    }
  });

  it('instance de test : la VM dédiée demandée', () => {
    expect(chooseVm({ userDataDirImposed: true, requested: 'atelier-e2e' })).toEqual({
      kind: 'lima',
      instanceName: 'atelier-e2e',
    });
    expect(chooseVm({ userDataDirImposed: true, requested: ' atelier-verif41 ' })).toEqual({
      kind: 'lima',
      instanceName: 'atelier-verif41',
    });
  });

  it('instance de test : jamais la VM atelier de la session principale', () => {
    const choice = chooseVm({ userDataDirImposed: true, requested: 'atelier' });
    expect(choice.kind).toBe('disabled');
    if (choice.kind === 'disabled') expect(choice.reason).toContain('session principale');
  });

  it('instance de test : refuse un nom sans préfixe ou que Lima rejetterait', () => {
    for (const requested of ['e2e', 'lima-e2e', 'atelier-', 'atelier-E2E', 'atelier-../x']) {
      const choice = chooseVm({ userDataDirImposed: true, requested });
      expect(choice.kind, requested).toBe('disabled');
      if (choice.kind === 'disabled') expect(choice.reason).toContain('invalide');
    }
  });
});
