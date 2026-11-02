import {z} from 'zod';
export const EDITORIAL = {
  status: {draft: 'draft', published: 'published', archived: 'archived'}, item: {outfit: 'outfit', product: 'product'},
  command: {create: 'create', edit: 'edit', publish: 'publish', archive: 'archive', restore: 'restore'},
  roles: ['admin', 'super_admin'], active: 'active',
  route: {root: 'editorial', collections: 'collections', managedPage: 'collections/managed', change: 'collections/changes/:requestId',
    managed: 'collections/:id/managed', collection: 'collections/:id', transition: 'collections/:id/:action', items: 'collections/:id/items'},
  param: {id: 'id', requestId: 'requestId', action: 'action'},
  limits: {zero: 0, one: 1, titleMin: 2, titleMax: 120, subtitleMax: 240, descriptionMax: 6000, urlMax: 2048,
    itemsMax: 100, pageDefault: 20, pageMax: 50, versionMax: 2147483646, cursorMax: 512},
  lock: {write: 'update', read: 'share'}, digest: {algorithm: 'sha256', encoding: 'hex', pattern: '^[0-9a-f]{64}$'},
  identitySeparator: ':',
  cursor: {encoding: 'base64url', payloadEncoding: 'utf8'}, timestamp: {zone: 'UTC', format: 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"', precision: 6}, protocols: ['http:', 'https:'],
  failure: {input: 'Invalid editorial collection command', page: 'Invalid editorial collection page',
    missing: 'Editorial collection not found', forbidden: 'Editorial administration is unavailable',
    changed: 'Editorial collection changed; refresh before continuing', request: 'Editorial request identifier already used',
    state: 'Editorial collection transition is unavailable', references: 'Editorial references must exist and be unique',
    publish: 'Every editorial reference must be publicly available before publication'},
} as const;
export const EDITORIAL_ITEM_TYPES = [EDITORIAL.item.outfit, EDITORIAL.item.product] as const;
export const EDITORIAL_STATUSES = [EDITORIAL.status.draft, EDITORIAL.status.published, EDITORIAL.status.archived] as const;
export const EDITORIAL_TRANSITIONS = [EDITORIAL.command.publish, EDITORIAL.command.archive, EDITORIAL.command.restore] as const;
export const EDITORIAL_COMMANDS = [EDITORIAL.command.create, EDITORIAL.command.edit, ...EDITORIAL_TRANSITIONS] as const;
const L = EDITORIAL.limits;
const uuid = z.uuid().transform(value => value.toLowerCase());
const version = z.number().int().min(L.zero).max(L.versionMax);
const position = z.number().int().min(L.zero).max(L.itemsMax - L.one);
const cover = z.url().max(L.urlMax).refine(value => {
  const parsed = new URL(value);
  return EDITORIAL.protocols.some(protocol => parsed.protocol === protocol) && !parsed.username && !parsed.password;
});
export const editorialItemSchema = z.discriminatedUnion('itemType', [
  z.object({itemType: z.literal(EDITORIAL.item.outfit), outfitId: uuid, position}).strict(),
  z.object({itemType: z.literal(EDITORIAL.item.product), productId: uuid, position}).strict(),
]);
export const editorialFieldsSchema = z.object({title: z.string().trim().min(L.titleMin).max(L.titleMax),
  subtitle: z.string().trim().min(L.one).max(L.subtitleMax).nullable(), description: z.string().trim().min(L.one).max(L.descriptionMax),
  coverImageUrl: cover.nullable(), items: z.array(editorialItemSchema).max(L.itemsMax),
}).strict().refine(fields => {
  const ordered = [...fields.items].sort((a, b) => a.position - b.position);
  const identities = fields.items.map(item => item.itemType + EDITORIAL.identitySeparator + (item.itemType === EDITORIAL.item.outfit ? item.outfitId : item.productId));
  return ordered.every((item, index) => item.position === index) && new Set(identities).size === identities.length;
}).transform(fields => ({...fields, items: [...fields.items].sort((a, b) => a.position - b.position)}));
export const editorialWriteSchema = z.object({requestId: uuid, expectedVersion: version, fields: editorialFieldsSchema}).strict();
export const editorialTransitionSchema = z.object({requestId: uuid, expectedVersion: version.min(L.one)}).strict();
const pageLimit = z.coerce.number().int().min(L.one).max(L.pageMax).default(L.pageDefault);
export const editorialPageSchema = z.object({cursor: z.string().min(L.one).max(L.cursorMax).optional(), limit: pageLimit}).strict();
export const editorialManagedPageSchema = z.object({cursor: uuid.optional(), limit: pageLimit, status: z.enum(EDITORIAL_STATUSES).optional()}).strict();
export const editorialListCursorSchema = z.object({publishedAt: z.iso.datetime({precision: EDITORIAL.timestamp.precision}), id: uuid}).strict();
export const editorialItemsPageSchema = z.object({cursor: z.string().min(L.one).max(L.cursorMax).optional(),
  limit: z.coerce.number().int().min(L.one).max(L.pageMax).default(L.pageDefault), version: z.coerce.number().int().min(L.one).max(L.versionMax)}).strict();
export const editorialCursorSchema = z.object({collectionId: uuid, version: version.min(L.one), position, id: uuid}).strict();
export type EditorialFields = z.infer<typeof editorialFieldsSchema>;
export type EditorialWrite = z.infer<typeof editorialWriteSchema>;
export type EditorialTransition = z.infer<typeof editorialTransitionSchema>;
export type EditorialPage = z.infer<typeof editorialPageSchema>;
export type EditorialManagedPage = z.infer<typeof editorialManagedPageSchema>;
export type EditorialItemsPage = z.infer<typeof editorialItemsPageSchema>;
export type EditorialCursor = z.infer<typeof editorialCursorSchema>;
export type EditorialCommandKind = (typeof EDITORIAL_COMMANDS)[number];
export type EditorialStatus = (typeof EDITORIAL_STATUSES)[number];

export type EditorialListCursor = z.infer<typeof editorialListCursorSchema>;

export type EditorialItemType = (typeof EDITORIAL.item)[keyof typeof EDITORIAL.item];
