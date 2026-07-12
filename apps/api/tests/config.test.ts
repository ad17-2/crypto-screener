import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'config/default.json');

describe('loadConfig', () => {
  it('validates config/default.json exactly as-is', () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);

    expect(config.version).toBe(2);
    expect(config.providers.coinglass.api_key_env).toBe('COINGLASS_API_KEY');
    expect(config.report.limit).toBe(12);
    expect(config.providers.coinglass.technical_indicators).toBeDefined();

    expect(config.factors.regime.dispersion_threshold_pct).toBe(8.0);
    expect(config.factors.reversal_lookback_hours).toBe(72);
  });

  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('rejects unknown keys', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crypto-screener-config-'));
    const configPath = join(tmpDir, 'bad.json');
    writeFileSync(configPath, JSON.stringify({ version: 2, unknown: true }), 'utf-8');

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects unknown keys nested inside a sub-object', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crypto-screener-config-'));
    const configPath = join(tmpDir, 'bad-nested.json');
    writeFileSync(
      configPath,
      JSON.stringify({ version: 2, report: { limit: 12, bogus_field: 1 } }),
      'utf-8',
    );

    expect(() => loadConfig(configPath)).toThrow();
  });
});
