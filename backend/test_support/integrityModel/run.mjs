#!/usr/bin/env node
/**
 * node test_support/integrityModel/run.mjs            print the results table
 * node test_support/integrityModel/run.mjs --write    regenerate ../docs/integrity/MODEL-RESULTS.md
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAll, renderMarkdown } from './report.mjs';

export const DOC_PATH = fileURLToPath(new URL('../../../docs/integrity/MODEL-RESULTS.md', import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = runAll();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(DOC_PATH, renderMarkdown(results));
    console.log(`wrote ${DOC_PATH}`);
  } else {
    for (const { scenario, result, violated } of results) {
      console.log(`${scenario.id.padEnd(4)} ${String(result.states).padStart(6)} states ${result.complete ? 'complete' : 'TRUNCATED'}  ${violated.length ? violated.join(', ') : 'no violation'}`);
    }
  }
}
