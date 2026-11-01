import {randomUUID} from 'node:crypto';
import {OUTFIT_EDITING, OUTFIT_STATUS, OUTFIT_VISIBILITY} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES, type PublicOutfitPage} from '../../src/modules/outfits/domain/public-outfit.contract';
import {PUBLIC_PROFILE} from '../../src/shared/domain/public-profile.contract';
import {PROFILE_STATUS, PROFILE_EDITING} from '../../src/shared/domain/profile-editing.contract';
import type {Outfit, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility, OutfitOwner, OutfitOwnerInfo, OutfitManagedQuery, OutfitTag, OutfitActor} from '../../src/modules/outfits/domain/outfit.types';
import type {ProductRepository} from '../../src/modules/products/domain/product.types';
const identities = new Map<string, string>();
export const fixtureID = (name: string) => { let value = identities.get(name); if (!value) { value = randomUUID(); identities.set(name, value); } return value; };
export const publicCreator = {id: fixtureID('creator'), kind: PUBLIC_PROFILE.kind.creator, name: 'Créateur de qualification', avatarUrl: null};
export const outfitFixture = {
  actor: {id: fixtureID('creator-user'), roles: [OUTFIT_EDITING.roles.creator]} satisfies OutfitActor,
  admin: {id: fixtureID('outfit-admin'), roles: ['admin']} satisfies OutfitActor,
  owner: {id: publicCreator.id, kind: PUBLIC_PROFILE.kind.creator, name: publicCreator.name, status: PROFILE_STATUS.active} satisfies OutfitOwnerInfo,
  timestamp: new Date('2026-05-20T00:00:00.000Z'),
  image: {url: 'https://cdn.test/outfit.jpg', position: OUTFIT_EDITING.limits.first},
  invalid: 'Invalid outfit fixture contract',
} as const;
export class MemoryOutfitRepository implements OutfitRepository {
  outfits = new Map<string, Outfit>();
  items: OutfitItem[] = [];
  images: OutfitImage[] = [];
  private sequence = OUTFIT_EDITING.versionInitial;
  private requests = new Map<string, {id: string; fingerprint: string}>();
  private selections = new Map<string, string[]>();
  readonly owners = new Map<string, OutfitOwnerInfo>([[outfitFixture.owner.id, {...outfitFixture.owner}]]);
  readonly members = new Map<string, Set<string>>([[outfitFixture.owner.id, new Set([outfitFixture.actor.id])]]);
  readonly tags: OutfitTag[] = [];
  constructor(private readonly products: Pick<ProductRepository, 'findActiveByIds'>) {}
  async transaction<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T> {
    const before = structuredClone({outfits: this.outfits, items: this.items, images: this.images, requests: this.requests, selections: this.selections});
    try { return await operation(this); }
    catch (error) { this.outfits = before.outfits; this.items = before.items; this.images = before.images; this.requests = before.requests; this.selections = before.selections; throw error; }
  }
  async readSnapshot<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T> { return operation(this); }
  async findEditableOwner(owner: OutfitOwner, userId: string) {
    if ((owner.creatorId === null) === (owner.brandId === null)) return undefined;
    const ownerID = owner.creatorId !== null ? owner.creatorId : owner.brandId!;
    const record = this.owners.get(ownerID);
    return record && PROFILE_EDITING.writableStatuses.some(status => status === record.status) && this.members.get(ownerID)?.has(userId) ? record : undefined;
  }
  async lockEditableOwner(owner: OutfitOwner, userId: string) { return this.findEditableOwner(owner, userId); }
  async lockOwner(_owner: OutfitOwner): Promise<void> {}
  async lockOutfit(id: string) { return this.outfits.get(id); }
  async findByCreationRequest(owner: OutfitOwner, requestId: string) {
    const request = this.requests.get(JSON.stringify(owner) + requestId);
    const detail = request ? await this.findById(request.id) : null;
    return detail && request ? {detail, fingerprint: request.fingerprint} : null;
  }
  async listManaged(query: OutfitManagedQuery) {
    const rows = [...this.outfits.values()].filter(row => (!query.creatorId || row.creatorId === query.creatorId) && (!query.brandId || row.brandId === query.brandId) && (!query.status || row.status === query.status) && (!query.cursor || row.id > query.cursor)).sort((a, b) => a.id.localeCompare(b.id));
    const page = rows.slice(OUTFIT_EDITING.limits.first, query.limit), items: OutfitDetail[] = [];
    for (const row of page) items.push((await this.findById(row.id))!);
    return {items, nextCursor: rows.length > query.limit ? page.at(OUTFIT_EDITING.limits.last)!.id : null};
  }
  async listTags() { return this.tags; }
  async findSelectableProductIds(ids: string[]) { return (await this.products.findActiveByIds(ids)).map(detail => detail.product.id); }
  async replaceTags(id: string, tagIds: string[]) { this.selections.set(id, [...tagIds]); }
  async replaceContent(id: string, input: Parameters<OutfitRepository['replaceContent']>[1]) {
    this.items = this.items.filter(item => item.outfitId !== id);
    this.items.push(...input.items.map(item => ({...item, outfitId: id, id: item.id ?? fixtureID(`item${this.sequence++}`)})));
    this.images = this.images.filter(image => image.outfitId !== id);
    this.images.push(...input.images.map(image => ({...image, outfitId: id, id: image.id ?? fixtureID(`image${this.sequence++}`)})));
    await this.replaceTags(id, input.tagIds);
    const before = this.outfits.get(id)!;
    this.outfits.set(id, {...before, ...input.fields, status: OUTFIT_STATUS.draft, visibility: OUTFIT_VISIBILITY.private,
      version: before.version + OUTFIT_EDITING.versionStep, reviewedBy: null, reviewedAt: null, rejectionReason: null, publishedAt: null});
  }

  async createOutfit(input: Parameters<OutfitRepository['createOutfit']>[0]): Promise<Outfit> {
    const outfit: Outfit = {
      id: fixtureID(`outfit${this.sequence++}`),
      version: OUTFIT_EDITING.versionInitial,
      status: 'draft',
      visibility: 'private',
      totalPriceMin: 0,
      totalPriceMax: 0,
      publishedAt: null,
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
      updatedAt: new Date('2026-05-20T00:00:00.000Z'),
      ...input
    };
    this.requests.set(JSON.stringify({creatorId: input.creatorId, brandId: input.brandId}) + input.creationRequestId, {id: outfit.id, fingerprint: input.creationFingerprint});
    this.outfits.set(outfit.id, outfit);
    return outfit;
  }

  async addItems(outfitId: string, items: Parameters<OutfitRepository['addItems']>[1]): Promise<OutfitItem[]> {
    const rows = items.map((item) => ({ id: fixtureID(`item${this.sequence++}`), outfitId, ...item }));
    this.items.push(...rows);
    return rows;
  }

  async addImages(outfitId: string, images: Parameters<OutfitRepository['addImages']>[1]): Promise<OutfitImage[]> {
    const rows = images.map((image) => ({ id: fixtureID(`image${this.sequence++}`), outfitId, ...image }));
    this.images.push(...rows);
    return rows;
  }

  async findById(outfitId: string): Promise<OutfitDetail | null> {
    const outfit = this.outfits.get(outfitId);
    return outfit
      ? {
          outfit,
          owner: outfit.creatorId ? this.owners.get(outfit.creatorId) ?? null : outfit.brandId ? this.owners.get(outfit.brandId) ?? null : null,
          tags: this.tags.filter(tag => this.selections.get(outfit.id)?.includes(tag.id)),
          author: outfit.creatorId === publicCreator.id && outfit.brandId === null && this.owners.get(outfit.creatorId)?.status === PROFILE_STATUS.active ? publicCreator : null,
          items: this.items.filter((item) => item.outfitId === outfitId),
          images: this.images.filter((image) => image.outfitId === outfitId)
        }
      : null;
  }

  async updateStatus(outfitId: string, status: OutfitStatus, visibility: OutfitVisibility, reviewerId?: string, rejectionReason?: string): Promise<Outfit> {
    const outfit = this.outfits.get(outfitId);
    if (!outfit) {
      throw new Error('missing outfit');
    }
    const updated = {
      ...outfit,
      version: outfit.version + OUTFIT_EDITING.versionStep,
      status,
      visibility,
      reviewedBy: reviewerId ?? null,
      reviewedAt: status === 'published' || status === 'rejected' ? new Date('2026-05-20T00:00:00.000Z') : null,
      rejectionReason: status === 'rejected' ? rejectionReason ?? null : null,
      publishedAt: status === 'published' ? new Date('2026-05-20T00:00:00.000Z') : null
    };
    this.outfits.set(outfitId, updated);
    return updated;
  }

  async updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit> {
    const outfit = this.outfits.get(outfitId);
    if (!outfit) {
      throw new Error('missing outfit');
    }
    const updated = { ...outfit, totalPriceMin, totalPriceMax };
    this.outfits.set(outfitId, updated);
    return updated;
  }

  async findPublishedPage(input: PublicOutfitPage): Promise<OutfitDetail[]> {
    const rows = [...this.outfits.values()]
      .filter((outfit) => outfit.status === PUBLIC_OUTFIT.status && PUBLIC_OUTFIT_VISIBILITIES.some(visibility => visibility === outfit.visibility) &&
        ((outfit.creatorId === null && outfit.brandId === null) || (outfit.creatorId === publicCreator.id && outfit.brandId === null)) &&
        (!input.creatorId || outfit.creatorId === input.creatorId) && (!input.brandId || outfit.brandId === input.brandId))
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((outfit) => (input.cursor ? outfit.id < input.cursor : true))
      .slice(0, input.limit);
    const details = await Promise.all(rows.map((outfit) => this.findById(outfit.id)));
    return details.filter((detail): detail is OutfitDetail => Boolean(detail));
  }
}
