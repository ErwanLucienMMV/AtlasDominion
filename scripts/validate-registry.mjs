import { readFile } from 'node:fs/promises';
import { validateRegistry } from '../libs/server-registry/index.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run validate:registry -- instance.json [instance.json ...]');
  process.exitCode = 1;
} else {
  try {
    const entries = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
    console.log(`Validated ${validateRegistry(entries).length} instance(s). No Docker operations performed.`);
  } catch {
    console.error('Registry rejected. Check JSON syntax, schema fields, labels, adapters, ownership and ports.');
    process.exitCode = 1;
  }
}
