import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {STYLE_PREFERENCES as S, stylePreferencesInputSchema as input, stylePreferencesDocumentSchema as document,
  stylePreferencesReceiptSchema as receipt} from '../../src/modules/identity/domain/style-preferences.contract';
const P = {user: randomUUID(), first: randomUUID(), second: randomUUID(), request: randomUUID(), invalid: 'invalid',
  time: '2026-11-02T12:00:00.000Z', excess: 1} as const;
const command = () => ({requestId: P.request, expectedVersion: S.version.absent, styleIds: [P.first, P.second]});
describe('Canonical style preferences contract', () => {
  it('normalizes UUID casing and set order without allowing duplicate styles', () => {
    expect(input.parse({...command(), styleIds: [P.second.toUpperCase(), P.first]})).toEqual({...command(), styleIds: [P.first, P.second].sort()});
    expect(input.safeParse({...command(), styleIds: [P.first, P.first.toUpperCase()]}).success).toBe(false);
  });
  it.each([
    {requestId: P.invalid}, {requestId: undefined}, {expectedVersion: undefined}, {expectedVersion: -S.version.step},
    {expectedVersion: S.version.maximum}, {styleIds: undefined}, {styleIds: [P.invalid]}, {styles: [P.first]},
    {styleIds: Array.from({length: S.maximumStyles + P.excess}, () => randomUUID())},
  ])('rejects invalid or noncanonical command: %j', invalid => {
    expect(input.safeParse({...command(), ...invalid}).success).toBe(false);
  });
  it('represents the absent document as an explicit empty choice', () => {
    expect(document.parse({userId: P.user, version: S.version.absent, styleIds: [], updatedAt: null}))
      .toEqual({userId: P.user, version: S.version.absent, styleIds: [], updatedAt: null});
    expect(document.safeParse({userId: P.user, version: S.version.absent, styleIds: [P.first], updatedAt: null}).success).toBe(false);
  });
  it.each([{updatedAt: undefined}, {updatedAt: null}, {styleIds: undefined}, {userId: P.invalid}, {selectedStyles: []}])('rejects malformed persisted document: %j', invalid => {
    expect(document.safeParse({userId: P.user, version: S.version.initial, styleIds: [], updatedAt: P.time, ...invalid}).success).toBe(false);
  });
  it('requires immutable request identity and positive resulting version', () => {
    expect(receipt.parse({requestId: P.request, version: S.version.initial})).toEqual({requestId: P.request, version: S.version.initial});
    expect(receipt.safeParse({version: S.version.initial}).success).toBe(false);
    expect(receipt.safeParse({requestId: P.request, version: S.version.absent}).success).toBe(false);
  });
});
