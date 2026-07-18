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
  FearGreedConfig,
  ForexFactoryConfig,
  ProvidersConfig,
  RegimeConfig,
  ReportConfig,
  SoSoValueConfig,
  UniverseConfig,
} from './schema.js';
export { AppConfigSchema } from './schema.js';

/**
 * Every schema in `./schema.ts` is `.strict()`, so unknown keys or bad types throw a ZodError.
 *
 * `path` is resolved against the PROCESS WORKING DIRECTORY, and it defaults to the repo-relative
 * `config/default.json` (see env.ts). The same is true of `storage_path` ("data/...") inside the
 * config it loads. So the API only runs correctly with cwd = REPO ROOT -- which is what production
 * does (scripts/start.mjs runs from the root) and what the CLIs assume.
 *
 * That invariant is why apps/api's `dev` script has to `cd ../..` first: npm runs a workspace script
 * with cwd = the workspace directory, so `tsx watch src/server.ts` would look for the config at
 * apps/api/config/default.json and die with ENOENT. Do not "simplify" that `cd` away.
 */
export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return AppConfigSchema.parse(parsed);
}
