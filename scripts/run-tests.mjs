#!/usr/bin/env node
// @ts-check

/**
 * Categorising test runner for `node --test` workspaces.
 *
 *   node scripts/run-tests.mjs            # default = unit + integration (no e2e)
 *   node scripts/run-tests.mjs unit       # only *.unit.test.ts
 *   node scripts/run-tests.mjs integration  # everything that is not e2e and not unit-only
 *   node scripts/run-tests.mjs e2e        # only *.e2e.test.ts
 *
 * Discovers files under `tests/**\/*.test.ts` and routes them by suffix.
 * Files without a category suffix (`foo.test.ts`) count as integration.
 */

import { glob } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "default";
const cwd = process.cwd();

const all = [];
for await (const file of glob("tests/**/*.test.ts", { cwd })) {
  all.push(file);
}

const isE2E = (f) => f.endsWith(".e2e.test.ts");
const isUnit = (f) => f.endsWith(".unit.test.ts");

let files;
switch (mode) {
  case "unit":
    files = all.filter(isUnit);
    break;
  case "integration":
    files = all.filter((f) => !isE2E(f) && !isUnit(f));
    break;
  case "e2e":
    files = all.filter(isE2E);
    break;
  case "default":
    files = all.filter((f) => !isE2E(f));
    break;
  default:
    console.error(`[run-tests] unknown mode: ${mode}`);
    process.exit(2);
}

if (files.length === 0) {
  console.log(`[run-tests] no tests matched mode=${mode}`);
  process.exit(0);
}

const sortedFiles = files.map((f) => resolve(cwd, f)).sort();

const result = spawnSync(
  process.execPath,
  ["--env-file-if-exists=.env.local", "--import", "tsx", "--test", ...sortedFiles],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
