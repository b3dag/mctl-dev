#!/usr/bin/env node
/**
 * Run every suite against a live stack.
 *
 *   node backend/test/run.mjs            all suites
 *   node backend/test/run.mjs race       one suite
 *
 * Requires a running stack with at least one server called "test". These are
 * integration tests on purpose; see helpers.mjs for why.
 */
import { results, heading, api } from './helpers.mjs';

import raceTests from './race.test.mjs';
import listsTests from './lists.test.mjs';
import lifecycleTests from './lifecycle.test.mjs';
import ownershipTests from './ownership.test.mjs';

const SUITES = {
  lifecycle: lifecycleTests,
  lists: listsTests,
  race: raceTests,
  ownership: ownershipTests,
};

const chosen = process.argv.slice(2);
const toRun = chosen.length ? chosen : Object.keys(SUITES);

for (const name of toRun) {
  if (!SUITES[name]) {
    console.error(`unknown suite "${name}"; known: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }
}

const health = await api('GET', '/api/health').catch(() => null);
if (!health || health.status !== 200) {
  console.error('the manager is not reachable; bring the stack up first');
  process.exit(2);
}
if (!health.body.docker) {
  console.error('the manager cannot reach Docker');
  process.exit(2);
}

const started = Date.now();
for (const name of toRun) {
  heading(name);
  try {
    await SUITES[name]();
  } catch (e) {
    results.failed.push(`${name} threw: ${e.message}`);
    console.log(`  FAIL  suite threw: ${e.message}`);
  }
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n${'='.repeat(60)}`);
if (results.failed.length === 0) {
  console.log(`ALL PASSED  ${results.passed} checks in ${seconds}s`);
  process.exit(0);
}
console.log(`${results.failed.length} FAILED, ${results.passed} passed, in ${seconds}s`);
for (const f of results.failed) console.log(`  - ${f}`);
process.exit(1);
