import { describe, expect, it } from 'vitest';
import {
  MODEL_CAPABILITIES,
  checkServerUrl,
  isTailscaleHost,
  openAiCompatibleBaseUrl,
} from '../src/index.js';

describe('checkServerUrl', () => {
  it.each([
    ['https://llm.example.com', true],
    ['http://localhost:11434', true],
    ['http://127.0.0.1:11434', true],
    ['http://[::1]:11434', true],
    ['http://100.101.102.103:11434', true],
    ['http://gpu.tailnet-abc.ts.net:11434', true],
    ['http://llm.example.com', false],
    ['http://192.168.1.10:11434', false],
    ['http://100.128.0.1', false],
    ['ftp://llm.example.com', false],
    ['pas une url', false],
  ])('%s → %s', (url, ok) => {
    expect(checkServerUrl(url).ok).toBe(ok);
  });

  it('distingue la raison du refus', () => {
    expect(checkServerUrl('http://llm.example.com')).toEqual({
      ok: false,
      reason: 'insecure_http',
    });
  });
});

describe('isTailscaleHost', () => {
  it('reconnaît la plage CGNAT 100.64.0.0/10', () => {
    expect(isTailscaleHost('100.64.0.1')).toBe(true);
    expect(isTailscaleHost('100.127.255.255')).toBe(true);
    expect(isTailscaleHost('100.63.0.1')).toBe(false);
  });
});

describe('openAiCompatibleBaseUrl', () => {
  it('ajoute /v1 une seule fois', () => {
    expect(openAiCompatibleBaseUrl('https://x.io/')).toBe('https://x.io/v1');
    expect(openAiCompatibleBaseUrl('https://x.io/v1')).toBe('https://x.io/v1');
  });
});

describe('MODEL_CAPABILITIES', () => {
  it('liste chaque capacité une seule fois, dont tools', () => {
    expect(new Set(MODEL_CAPABILITIES).size).toBe(MODEL_CAPABILITIES.length);
    expect(MODEL_CAPABILITIES).toContain('tools');
  });
});
