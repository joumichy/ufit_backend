import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {CURRENCY_MINOR_UNITS} from '../../src/shared/domain/currencies';

const generator = {
  script: resolve('scripts/generate-currency-contract.mjs'),
  source: resolve('src/shared/domain/currencies.ts'),
  temporaryPrefix: 'ufit-currency-contract-',
  outputName: 'CurrencyMinorUnits.generated.swift',
  outputOption: '--output', checkOption: '--check',
  encoding: 'utf8', digest: 'sha256',
  swiftRow: /^        "([A-Z]{3})": (\d),$/gm,
  fingerprint: /sourceSHA256 = "([a-f0-9]{64})"/,
} as const;
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
function generate(): string {
  const directory = mkdtempSync(resolve(tmpdir(), generator.temporaryPrefix));
  temporaryDirectories.push(directory);
  const output = resolve(directory, generator.outputName);
  execFileSync(process.execPath, [generator.script, generator.outputOption, output]);
  return output;
}

describe('generated offline Swift currency contract', () => {
  it('preserves all accounting entries and fingerprints the exact canonical source', () => {
    const output = generate();
    const swift = readFileSync(output, generator.encoding);
    const digest = createHash(generator.digest).update(readFileSync(generator.source)).digest('hex');
    expect(swift.match(generator.fingerprint)?.[1]).toBe(digest);
    const mirrored = Object.fromEntries([...swift.matchAll(generator.swiftRow)].map(([, code, digits]) => [code, Number(digits)]));
    expect(mirrored).toEqual(CURRENCY_MINOR_UNITS);
    expect(execFileSync(process.execPath, [generator.script, generator.checkOption, generator.outputOption, output],
      {encoding: generator.encoding})).toContain('fingerprint match');
    execFileSync(process.execPath, [generator.script, generator.outputOption, output]);
    expect(readFileSync(output, generator.encoding)).toBe(swift);
  });
  it('detects an altered mirror without rewriting it in check mode', () => {
    const output = generate();
    const altered = readFileSync(output, generator.encoding).replace('"HUF": 2', '"HUF": 0');
    writeFileSync(output, altered);
    const result = spawnSync(process.execPath, [generator.script, generator.checkOption, generator.outputOption, output]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('differs from its canonical source');
    expect(readFileSync(output, generator.encoding)).toBe(altered);
  });
});
