// npm run openapi writes openapi.json from the contracts; --check fails if the committed file is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi } from '../src/common/http/openapi.js';
import { ALL_ROUTES } from '../src/contract.js';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'openapi.json');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const text = JSON.stringify(buildOpenApi(ALL_ROUTES, pkg.version), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(file, 'utf8');
  } catch {
    // missing file is reported below
  }
  if (committed !== text) {
    console.error('openapi:check: openapi.json is out of date. Run npm run openapi and commit it.');
    process.exit(1);
  }
  console.log('openapi:check: openapi.json matches the contracts.');
} else {
  writeFileSync(file, text);
  console.log(`openapi: wrote openapi.json (${ALL_ROUTES.length} operations)`);
}
