import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeInfrastructure } from '../libs/infrastructure/index.mjs';

try {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/render-infrastructure.mjs <settings.json> <new-output-directory>');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  await writeInfrastructure(config, resolve(process.argv[3]));
  console.log('Infrastructure rendered. No Docker or host changes performed. Review before deployment.');
} catch {
  // Do not echo configuration, credentials, personal contact details or filesystem paths.
  console.error('Infrastructure rendering failed: check settings and use a new output directory.');
  process.exitCode = 1;
}
