import { readFileSync } from 'node:fs';
import type { AppConfig } from './schema.js';
import { AppConfigSchema } from './schema.js';

export type {
  AppConfig,
  CoinGeckoConfig,
  CoinGlassConfig,
  CostsConfig,
  DataQualityConfig,
  FactorsConfig,
  ProvidersConfig,
  RegimeConfig,
  RegimeWeightingConfig,
  ReportConfig,
  SoSoValueConfig,
  UniverseConfig,
} from './schema.js';
export { AppConfigSchema } from './schema.js';

export type AppConfigDict = AppConfig;

/** Every schema in `./schema.ts` is `.strict()`, so unknown keys or bad types throw a ZodError. */
export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return AppConfigSchema.parse(parsed);
}

export function toRuntimeDict(config: AppConfig): AppConfigDict {
  return JSON.parse(JSON.stringify(config)) as AppConfigDict;
}

export function loadConfigDict(path: string): AppConfigDict {
  return toRuntimeDict(loadConfig(path));
}
