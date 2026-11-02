import { describe, expectTypeOf, it } from 'vitest';
import type { AppSettingsPatch, VoiceSettings } from '../src/index.js';

describe('AppSettingsPatch', () => {
  it('une section optionnelle (voice) accepte un patch partiel', () => {
    expectTypeOf<{ voice: { enabled: true } }>().toExtend<AppSettingsPatch>();
    expectTypeOf<NonNullable<AppSettingsPatch['voice']>>().toEqualTypeOf<Partial<VoiceSettings>>();
  });

  it('les sections obligatoires restent partielles, les scalaires inchangés', () => {
    expectTypeOf<{ search: Record<string, never> }>().toExtend<AppSettingsPatch>();
    expectTypeOf<NonNullable<AppSettingsPatch['openAtLogin']>>().toEqualTypeOf<boolean>();
    expectTypeOf<NonNullable<AppSettingsPatch['skillsDir']>>().toEqualTypeOf<string>();
  });
});
