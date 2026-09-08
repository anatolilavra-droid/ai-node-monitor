// Verifies .env.example parses into a valid AppConfig, i.e. that every
// required field is either present or has a safe default, and every
// value is well-formed. Run after `npm run build` (needs dist/):
//
//   node scripts/checkEnvExample.mjs
//
// Wired into CI (.github/workflows/ci.yml) so a typo or a newly-added
// required field without a default fails the build instead of silently
// shipping a broken .env.example.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envExamplePath = join(__dirname, '..', '.env.example');

function parseEnvFile(raw) {
  const env = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

const raw = readFileSync(envExamplePath, 'utf8');
const env = parseEnvFile(raw);

const { loadConfig } = await import('../dist/config/env.js');

try {
  const config = loadConfig(env);
  console.log('.env.example parses into a valid configuration:');
  console.log(JSON.stringify({ ...config, API_AUTH_KEY: config.API_AUTH_KEY ? '[set]' : undefined }, null, 2));
} catch (err) {
  console.error('.env.example is INVALID:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
