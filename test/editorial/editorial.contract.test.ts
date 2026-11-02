import type {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {EDITORIAL as E, editorialCursorSchema, editorialListCursorSchema, editorialFieldsSchema, editorialItemsPageSchema, editorialManagedPageSchema,
  editorialPageSchema, editorialTransitionSchema, editorialWriteSchema} from '../../src/modules/editorial/domain/editorial.contract';
const F = {title: 'Minimal edit', description: 'Une sélection de silhouettes.', image: 'https://cdn.example.test/editorial.jpg',
  subtitle: 'Le regard Ufit', unknown: 'unknown', wrong: 'not-a-uuid', tooLong: 'x', invalid: -1, fraction: 1.5,
  protocols: ['file:///private/image.jpg', 'javascript:alert(1)', 'https://user:password@example.test/image.jpg'],
  errors: ['NaN', 'Infinity', '0', '-1', '1.5', '51'], cursor: 'eyJpZCI6MX0', count: 2, first: 0, second: 1} as const;
const fields = (): z.input<typeof editorialFieldsSchema> => ({title: F.title, subtitle: null, description: F.description, coverImageUrl: null,
  items: [{itemType: E.item.outfit, outfitId: randomUUID(), position: F.first}, {itemType: E.item.product, productId: randomUUID(), position: F.second}]});
describe('canonical editorial contracts', () => {
  it('accepts both outfit and product references and canonicalizes case and order', () => {
    const value = fields(); value.items.reverse();
    const result = editorialFieldsSchema.parse(value);
    expect(result.items.map(item => item.position)).toEqual([F.first, F.second]);
    const command = editorialWriteSchema.parse({requestId: randomUUID().toUpperCase(), expectedVersion: E.limits.zero, fields: value});
    expect(command.requestId).toEqual(command.requestId.toLowerCase());
  });
  it('distinguishes outfit and product identities even when UUID values match', () => {
    const id = randomUUID();
    expect(editorialFieldsSchema.parse({...fields(), items: [{itemType: E.item.outfit, outfitId: id, position: F.first},
      {itemType: E.item.product, productId: id, position: F.second}]}).items.length).toBe(F.count);
  });
  it('preserves PostgreSQL timestamp precision in publication cursors', () => {
    const cursor = {id: randomUUID(), publishedAt: K.timestamp};
    expect(editorialListCursorSchema.parse(cursor)).toEqual(cursor);
    expect(editorialListCursorSchema.safeParse({...cursor, publishedAt: K.milliseconds}).success).toBe(false);
  });
  it('requires explicit nullable fields and an explicit item list', () => {
    for (const key of [K.subtitle, K.coverImageUrl, K.items]) {
      const value: Record<string, unknown> = fields(); delete value[key]; expect(editorialFieldsSchema.safeParse(value).success).toBe(false);
    }
  });
  it('rejects mismatched, missing, duplicate and legacy reference identities', () => {
    const id = randomUUID(), base = fields();
    const malformed = [{itemType: E.item.outfit, position: F.first},
      {itemType: E.item.outfit, outfitId: id, productId: randomUUID(), position: F.first},
      {itemType: E.item.product, outfitId: id, position: F.first},
      {kind: E.item.outfit, contentId: id, position: F.first}];
    malformed.forEach(item => expect(editorialFieldsSchema.safeParse({...base, items: [item]}).success).toBe(false));
    expect(editorialFieldsSchema.safeParse({...base, items: [{itemType: E.item.outfit, outfitId: id, position: F.first},
      {itemType: E.item.outfit, outfitId: id.toUpperCase(), position: F.second}]}).success).toBe(false);
  });
  it('rejects duplicate, gapped, negative and fractional positions', () => {
    for (const position of [F.first, F.count, F.invalid, F.fraction]) {
      const value = fields(); value.items[F.second].position = position;
      expect(editorialFieldsSchema.safeParse(value).success).toBe(false);
    }
  });
  it('allows an empty draft without inventing content', () => expect(editorialFieldsSchema.parse({...fields(), items: []}).items).toEqual([]));
  it('bounds text and collection size', () => {
    expect(editorialFieldsSchema.safeParse({...fields(), title: F.tooLong.repeat(E.limits.titleMax + E.limits.one)}).success).toBe(false);
    expect(editorialFieldsSchema.safeParse({...fields(), title: K.blank}).success).toBe(false);
    expect(editorialFieldsSchema.safeParse({...fields(), description: K.blank}).success).toBe(false);
    expect(editorialFieldsSchema.safeParse({...fields(), items: Array.from({length: E.limits.itemsMax + E.limits.one}, (_, position) => ({itemType: E.item.outfit, outfitId: randomUUID(), position}))}).success).toBe(false);
  });
  it('requires a credential-free HTTP cover URL', () => {
    F.protocols.forEach(coverImageUrl => expect(editorialFieldsSchema.safeParse({...fields(), coverImageUrl}).success).toBe(false));
    expect(editorialFieldsSchema.parse({...fields(), coverImageUrl: F.image}).coverImageUrl).toBe(F.image);
  });
  it('rejects unknown actor, status and legacy write fields', () => {
    for (const extra of [{createdBy: randomUUID()}, {status: E.status.published}, {title: F.title}]) {
      expect(editorialWriteSchema.safeParse({requestId: randomUUID(), expectedVersion: E.limits.zero, fields: fields(), ...extra}).success).toBe(false);
    }
  });
  it('requires request identity and integer expected version', () => {
    const command = {requestId: randomUUID(), expectedVersion: E.limits.one, fields: fields()};
    expect(editorialWriteSchema.safeParse({...command, requestId: F.wrong}).success).toBe(false);
    expect(editorialWriteSchema.safeParse({...command, expectedVersion: F.fraction}).success).toBe(false);
    expect(editorialTransitionSchema.safeParse({...command, fields: undefined}).success).toBe(false);
    expect(editorialTransitionSchema.safeParse({requestId: command.requestId, expectedVersion: E.limits.zero}).success).toBe(false);
  });
  it.each(F.errors)('rejects invalid list limit %s before database access', limit => expect(editorialPageSchema.safeParse({limit}).success).toBe(false));
  it('requires a collection version for public item paging', () => {
    expect(editorialItemsPageSchema.safeParse({}).success).toBe(false);
    expect(editorialItemsPageSchema.parse({version: E.limits.one}).limit).toBe(E.limits.pageDefault);
    expect(editorialItemsPageSchema.safeParse({version: E.limits.one, cursor: F.tooLong.repeat(E.limits.cursorMax + E.limits.one)}).success).toBe(false);
  });
  it('separates public and administrator query contracts', () => {
    expect(editorialPageSchema.safeParse({status: E.status.draft}).success).toBe(false);
    expect(editorialManagedPageSchema.parse({status: E.status.draft}).status).toBe(E.status.draft);
    expect(editorialManagedPageSchema.safeParse({status: F.unknown}).success).toBe(false);
  });
  it('requires a scoped, position-bearing cursor', () => {
    expect(editorialCursorSchema.safeParse({id: randomUUID()}).success).toBe(false);
    expect(editorialCursorSchema.parse({id: randomUUID(), collectionId: randomUUID(), version: E.limits.one, position: F.first}).position).toBe(F.first);
  });
});
const K = {timestamp: '2026-01-01T00:00:00.123456Z', milliseconds: '2026-01-01T00:00:00.123Z', subtitle: 'subtitle', coverImageUrl: 'coverImageUrl', items: 'items', blank: '   '} as const;
