import {OUTFIT_MEDIA} from '../../media/domain/outfit-media.contract';
import type {OutfitMediaReader} from '../../media/domain/outfit-media.types';
import {createHash} from 'node:crypto';
import {OUTFIT_EDITING, OUTFIT_STATUS, OUTFIT_STATUSES, OUTFIT_VISIBILITY, OUTFIT_ADMIN_ROLES, OUTFIT_ITEM_TYPES, OUTFIT_TAG_TYPES} from '../domain/outfit-editing.contract';
import {PROFILE_STATUS, canAuthorProfile} from '../../../shared/domain/profile-editing.contract';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PRODUCT_REPOSITORY, type ProductDetail, type ProductRepository } from '../../products/domain/product.types';
import { OUTFIT_REPOSITORY, type OutfitAuthor, type OutfitDetail, type OutfitItem, type OutfitRepository, type OutfitActor, type OutfitOwner, type OutfitContentUpdate } from '../domain/outfit.types';
import { CreateOutfitDto, ReviewOutfitDto, UpdateOutfitDto, OutfitVersionDto, EditOutfitItemDto, EditOutfitImageDto } from './dto/outfit.dto';
import {z} from 'zod';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES, OUTFIT_DISCOVERY, OUTFIT_SEARCH_SCOPES} from '../domain/public-outfit.contract';

const publicPage = z.object({limit: z.coerce.number().int().min(PUBLIC_OUTFIT.limits.minimum).max(PUBLIC_OUTFIT.limits.maximum).default(PUBLIC_OUTFIT.limits.default),
  cursor: z.uuid().optional(), creatorId: z.uuid().optional(), brandId: z.uuid().optional(),
  q: z.string().trim().max(OUTFIT_DISCOVERY.queryMax).optional(), scope: z.enum(OUTFIT_SEARCH_SCOPES).optional(),
  styleId: z.uuid().optional(), occasionId: z.uuid().optional(), itemType: z.enum(OUTFIT_ITEM_TYPES).optional(),
}).strict().refine(value => !(value.creatorId && value.brandId));

const managedOwner = z.object({creatorId: z.uuid().optional(), brandId: z.uuid().optional()}).strict();
const managedPage = managedOwner.extend({limit: z.coerce.number().int().min(OUTFIT_EDITING.limits.pageMin).max(OUTFIT_EDITING.limits.pageMax).default(OUTFIT_EDITING.limits.pageDefault),
  cursor: z.uuid().optional(), status: z.enum(OUTFIT_STATUSES).optional()}).strict()
  .refine(value => !(value.creatorId && value.brandId));

export interface OutfitPriceDto { currency: string; min: number; max: number }

export interface OutfitCardDto {
  id: string;
  title: string;
  coverImageUrl: string;
  prices: OutfitPriceDto[];
  author: OutfitAuthor | null;
  creatorId: string | null;
  brandId: string | null;
  publishedAt: string | null;
  pins: OutfitDetail['pins'];
  items: OutfitDetailDto['items'];
  images: Array<{id: string; url: string; position: number}>;
}

export interface OutfitDetailDto extends OutfitCardDto {
  description: string;
  creatorId: string | null;
  brandId: string | null;
  items: Array<{
    id: string;
    itemType: OutfitItem['itemType'];
    label: string;
    position: number;
    isRequired: boolean;
    isShoppable: boolean;
    stylingNote: string | null;
    product: null | { id: string; name: string; brandId: string; brandName: string; price: number; currency: string; imageUrl: string | null };
  }>;
}

@Injectable()
export class OutfitsService {
  constructor(
    @Inject(OUTFIT_REPOSITORY) private readonly outfits: OutfitRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(OUTFIT_MEDIA.reader) private readonly media: OutfitMediaReader
  ) {}

  async createOutfit(user: OutfitActor, input: CreateOutfitDto) {
    const owner = this.owner(input), content = this.content(input), fingerprint = createHash(OUTFIT_EDITING.creation.hash)
      .update(JSON.stringify({...content, pins: content.pins.length ? content.pins : undefined})).digest(OUTFIT_EDITING.creation.encoding);
    const detail = await this.outfits.transaction(async repository => {
      await this.requireOwner(repository, owner, user, true);
      const existing = await repository.findByCreationRequest(owner, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException(OUTFIT_EDITING.failure.request);
        return existing.detail;
      }
      await this.validateContent(repository, owner, content);
      const outfit = await repository.createOutfit({...owner, ...content.fields, creationRequestId: input.requestId, creationFingerprint: fingerprint,
        reviewedBy: null, reviewedAt: null, rejectionReason: null});
      await repository.addItems(outfit.id, content.items.map(({id: _, ...item}) => item));
      await repository.addImages(outfit.id, content.images.map(({id: _, ...image}) => image));
      await repository.replaceTags(outfit.id, content.tagIds);
      await repository.replacePins(outfit.id, content.pins);
      return this.requireOutfit(outfit.id, repository);
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async updateOutfit(user: OutfitActor, id: string, input: UpdateOutfitDto) {
    const content = this.content(input);
    const detail = await this.mutate(user, id, input, false, async (repository, before) => {
      if (before.outfit.status === OUTFIT_STATUS.underReview || before.outfit.status === OUTFIT_STATUS.submitted || before.outfit.status === OUTFIT_STATUS.archived) throw new ConflictException(OUTFIT_EDITING.failure.state);
      const itemIds = content.items.flatMap(item => item.id ? [item.id] : []), imageIds = content.images.flatMap(image => image.id ? [image.id] : []);
      if (new Set(itemIds).size !== itemIds.length || itemIds.some(id => !before.items.some(item => item.id === id))) throw new BadRequestException(OUTFIT_EDITING.failure.items);
      if (new Set(imageIds).size !== imageIds.length || imageIds.some(id => !before.images.some(image => image.id === id))) throw new BadRequestException(OUTFIT_EDITING.failure.images);
      await this.validateContent(repository, this.owner(before.outfit), content);
      await repository.replaceContent(id, content);
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async submitOutfit(user: OutfitActor, id: string, input: OutfitVersionDto) {
    const detail = await this.mutate(user, id, input, false, async (repository, before) => {
      if (before.outfit.status !== OUTFIT_STATUS.draft && before.outfit.status !== OUTFIT_STATUS.rejected) throw new ConflictException(OUTFIT_EDITING.failure.state);
      this.requireComplete(before);
      await this.validateContent(repository, this.owner(before.outfit), {fields: before.outfit, items: before.items, images: before.images, tagIds: before.tags.map(tag => tag.id), pins: before.pins.map(pin => ({imagePosition: before.images.find(image => image.id === pin.imageId)!.position, itemPosition: before.items.find(item => item.id === pin.itemId)!.position, x: pin.x, y: pin.y}))});
      await repository.updateStatus(id, OUTFIT_STATUS.underReview, OUTFIT_VISIBILITY.private);
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async reviewOutfit(user: OutfitActor, id: string, input: ReviewOutfitDto) {
    this.requireAdmin(user);
    const reason = input.rejectionReason?.trim();
    if (input.decision === OUTFIT_STATUS.rejected && !reason) throw new BadRequestException(OUTFIT_EDITING.failure.reason);
    const before = await this.outfits.readSnapshot(repository => this.requireOutfit(id, repository));
    this.requireReviewable(before, input);
    const prepared = await this.prepareManaged([before]);
    const detail = await this.mutate(user, id, input, true, async (repository, before) => {
      this.requireReviewable(before, input);
      if (input.decision === OUTFIT_STATUS.published) {
        await this.validateContent(repository, this.owner(before.outfit), {fields: before.outfit, items: before.items, images: before.images, tagIds: before.tags.map(tag => tag.id), pins: before.pins.map(pin => ({imagePosition: before.images.find(image => image.id === pin.imageId)!.position, itemPosition: before.items.find(item => item.id === pin.itemId)!.position, x: pin.x, y: pin.y}))});
      }
      await repository.updateStatus(id, input.decision, input.decision === OUTFIT_STATUS.published ? OUTFIT_VISIBILITY.public : OUTFIT_VISIBILITY.private, user.id, reason);
    });
    return this.toManagedDetail(detail, prepared.products, prepared.displays);
  }
  async archiveOutfit(user: OutfitActor, id: string, input: OutfitVersionDto) {
    const detail = await this.mutate(user, id, input, this.isAdmin(user), async (repository, before) => {
      if (before.outfit.status === OUTFIT_STATUS.archived) throw new ConflictException(OUTFIT_EDITING.failure.state);
      await repository.updateStatus(id, OUTFIT_STATUS.archived, OUTFIT_VISIBILITY.private);
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async restoreOutfit(user: OutfitActor, id: string, input: OutfitVersionDto) {
    const detail = await this.mutate(user, id, input, this.isAdmin(user), async (repository, before) => {
      if (before.outfit.status !== OUTFIT_STATUS.archived) throw new ConflictException(OUTFIT_EDITING.failure.state);
      await repository.updateStatus(id, OUTFIT_STATUS.draft, OUTFIT_VISIBILITY.private);
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async getManagedOutfit(user: OutfitActor, id: string) {
    const detail = await this.outfits.readSnapshot(async repository => {
      const value = await this.requireOutfit(id, repository);
      if (!this.isAdmin(user)) await this.requireOwner(repository, this.owner(value.outfit), user, false);
      return value;
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async recoverCreation(user: OutfitActor, ownerInput: {creatorId?: string; brandId?: string}, requestId: string) {
    const parsed = managedOwner.safeParse(ownerInput);
    if (!parsed.success) throw new BadRequestException(OUTFIT_EDITING.failure.page);
    const owner = this.owner(parsed.data);
    const detail = await this.outfits.readSnapshot(async repository => {
      await this.requireOwner(repository, owner, user, false);
      const existing = await repository.findByCreationRequest(owner, requestId);
      if (!existing) throw new NotFoundException(OUTFIT_EDITING.failure.missing);
      return existing.detail;
    });
    return (await this.projectManaged([detail]))[OUTFIT_EDITING.limits.first];
  }
  async listManagedOutfits(user: OutfitActor, input: unknown) {
    const parsed = managedPage.safeParse(input);
    if (!parsed.success) throw new BadRequestException(OUTFIT_EDITING.failure.page);
    const page = await this.outfits.readSnapshot(async repository => {
      if (!this.isAdmin(user)) await this.requireOwner(repository, this.owner(parsed.data), user, false);
      return repository.listManaged(parsed.data);
    });
    return {items: await this.projectManaged(page.items), nextCursor: page.nextCursor};
  }
  async getMetadata() { return {tags: await this.outfits.listTags(), itemTypes: OUTFIT_ITEM_TYPES, tagTypes: OUTFIT_TAG_TYPES, statuses: OUTFIT_STATUSES}; }

  async getDiscoveryOptions() {
    const tags = (await this.outfits.listTags()).filter(tag => tag.type === OUTFIT_DISCOVERY.tag.style || tag.type === OUTFIT_DISCOVERY.tag.occasion);
    return {tags, itemTypes: OUTFIT_ITEM_TYPES};
  }

  private owner(input: {creatorId?: string | null; brandId?: string | null}): OutfitOwner {
    const creatorId = input.creatorId?.toLowerCase() ?? null, brandId = input.brandId?.toLowerCase() ?? null;
    if (creatorId !== null && brandId === null) return {creatorId, brandId};
    if (brandId !== null && creatorId === null) return {creatorId, brandId};
    throw new BadRequestException(OUTFIT_EDITING.failure.owner);
  }
  private isAdmin(user: OutfitActor) { return user.roles.some(role => OUTFIT_ADMIN_ROLES.some(admin => admin === role)); }
  private requireAdmin(user: OutfitActor) { if (!this.isAdmin(user)) throw new ForbiddenException(OUTFIT_EDITING.failure.access); }
  private async requireOwner(repository: OutfitRepository, owner: OutfitOwner, user: OutfitActor, lock: boolean) {
    if (!canAuthorProfile(user.roles, owner)) throw new ForbiddenException(OUTFIT_EDITING.failure.access);
    const profile = lock ? await repository.lockEditableOwner(owner, user.id) : await repository.findEditableOwner(owner, user.id);
    if (!profile) throw new ForbiddenException(OUTFIT_EDITING.failure.access);
    return profile;
  }
  private async mutate(user: OutfitActor, id: string, input: OutfitVersionDto, moderation: boolean,
    operation: (repository: OutfitRepository, detail: OutfitDetail) => Promise<void>): Promise<OutfitDetail> {
    const before = await this.outfits.readSnapshot(repository => this.requireOutfit(id, repository)), owner = this.owner(before.outfit);
    return this.outfits.transaction(async repository => {
      if (moderation) { this.requireAdmin(user); await repository.lockOwner(owner); }
      else await this.requireOwner(repository, owner, user, true);
      const locked = await repository.lockOutfit(id);
      if (!locked) throw new NotFoundException(OUTFIT_EDITING.failure.missing);
      if (locked.version !== input.expectedVersion) throw new ConflictException(OUTFIT_EDITING.failure.changed);
      const detail = await this.requireOutfit(id, repository);
      await operation(repository, detail);
      return this.requireOutfit(id, repository);
    });
  }
  private content(input: CreateOutfitDto | UpdateOutfitDto): OutfitContentUpdate {
    const items = input.items.map(item => ({id: (item as EditOutfitItemDto).id?.toLowerCase(), productId: item.productId?.toLowerCase() ?? null,
      externalLabel: item.externalLabel ?? null, itemType: item.itemType, position: item.position, isRequired: item.isRequired,
      isShoppable: item.isShoppable, stylingNote: item.stylingNote ?? null}))
      .sort((left, right) => left.position - right.position);
    const images = input.images.map(image => ({id: (image as EditOutfitImageDto).id?.toLowerCase(), url: image.url, position: image.position})).sort((left, right) => left.position - right.position);
    return {fields: {title: input.title, description: input.description, genderTarget: input.genderTarget ?? null,
      coverImageUrl: images[OUTFIT_EDITING.limits.first]?.url ?? OUTFIT_EDITING.emptyImage}, items, images, tagIds: input.tagIds.map(id => id.toLowerCase()).sort(), pins: [...(input.pins ?? [])].sort((left, right) => left.imagePosition - right.imagePosition || left.itemPosition - right.itemPosition)};
  }
  private async validateContent(repository: OutfitRepository, owner: OutfitOwner, content: OutfitContentUpdate): Promise<void> {
    const pairs = content.pins.map(pin => JSON.stringify([pin.imagePosition, pin.itemPosition]));
    if (content.pins.length > OUTFIT_EDITING.limits.pinsMax || new Set(pairs).size !== pairs.length || content.pins.some(pin =>
      !content.images.some(image => image.position === pin.imagePosition) || !content.items.some(item => item.position === pin.itemPosition) ||
      !Number.isInteger(pin.x) || !Number.isInteger(pin.y) || pin.x < OUTFIT_EDITING.limits.integerMin || pin.y < OUTFIT_EDITING.limits.integerMin ||
      pin.x > OUTFIT_EDITING.limits.pinCoordinateMax || pin.y > OUTFIT_EDITING.limits.pinCoordinateMax)) throw new BadRequestException(OUTFIT_EDITING.failure.pins);
    const assetIds = this.media.assetIDs(content.images.map(image => image.url));
    if (!await repository.hasReadyOutfitMedia(owner, assetIds)) throw new BadRequestException(OUTFIT_MEDIA.failure.ownership);
    const ids = content.items.flatMap(item => item.productId ? [item.productId] : []);
    if (new Set(ids).size !== ids.length || new Set(content.items.map(item => item.position)).size !== content.items.length ||
        content.items.some(item => item.isShoppable ? !item.productId || item.externalLabel !== null : item.productId !== null || !item.externalLabel?.trim())) throw new BadRequestException(OUTFIT_EDITING.failure.items);
    if (new Set(content.images.map(image => image.position)).size !== content.images.length) throw new BadRequestException(OUTFIT_EDITING.failure.images);
    if ((await repository.findSelectableProductIds(ids)).length !== ids.length) throw new BadRequestException(OUTFIT_EDITING.failure.items);
    const available = new Set((await repository.listTags()).map(tag => tag.id));
    if (new Set(content.tagIds).size !== content.tagIds.length || content.tagIds.some(id => !available.has(id))) throw new BadRequestException(OUTFIT_EDITING.failure.tags);
  }
  private requireReviewable(detail: OutfitDetail, input: ReviewOutfitDto) {
    if (detail.outfit.version !== input.expectedVersion) throw new ConflictException(OUTFIT_EDITING.failure.changed);
    if (detail.outfit.status !== OUTFIT_STATUS.underReview) throw new ConflictException(OUTFIT_EDITING.failure.state);
    if (input.decision === OUTFIT_STATUS.published) this.requireComplete(detail);
  }
  private requireComplete(detail: OutfitDetail) {
    if (detail.owner?.status !== PROFILE_STATUS.active || detail.author === null || !detail.outfit.description.trim() ||
        detail.items.length < OUTFIT_EDITING.limits.readyItems || detail.images.length < OUTFIT_EDITING.limits.readyImages) throw new BadRequestException(OUTFIT_EDITING.failure.incomplete);
  }
  private async prepareManaged(details: OutfitDetail[]) {
    const sources = details.flatMap(detail => detail.images.map(image => ({url: image.url,
      owner: detail.outfit.creatorId !== null || detail.outfit.brandId !== null ? this.owner(detail.outfit) : null})));
    const displays = await this.media.resolveImages(sources);
    const products = await this.products.findActiveByIds(this.uniqueShoppableProductIds(details.flatMap(detail => detail.items)));
    return {displays, products};
  }
  private async projectManaged(details: OutfitDetail[]) {
    const prepared = await this.prepareManaged(details);
    return details.map(detail => this.toManagedDetail(detail, prepared.products, prepared.displays));
  }
  private toManagedDetail(detail: OutfitDetail, products: ProductDetail[], displays: Map<string, string>) {
    const publicFields = this.toOutfitDetail(detail, products);
    const sourceById = new Map(detail.items.map(item => [item.id, item]));
    return {...publicFields, version: detail.outfit.version, status: detail.outfit.status, visibility: detail.outfit.visibility,
      owner: detail.owner, genderTarget: detail.outfit.genderTarget, rejectionReason: detail.outfit.rejectionReason,
      reviewedAt: detail.outfit.reviewedAt?.toISOString() ?? null, createdAt: detail.outfit.createdAt.toISOString(),
      updatedAt: detail.outfit.updatedAt.toISOString(), images: detail.images.map(image => {
        const displayUrl = displays.get(image.url);
        if (!displayUrl) throw new BadRequestException(OUTFIT_MEDIA.failure.ownership);
        return {id: image.id, url: image.url, displayUrl, position: image.position};
      }),
      items: publicFields.items.map(item => {
        const source = sourceById.get(item.id)!;
        return {...item, isShoppable: source.isShoppable, productId: source.productId, externalLabel: source.externalLabel};
      }), tags: detail.tags};
  }

  async getPublicFeed(input: unknown): Promise<{ items: OutfitCardDto[]; nextCursor: string | null }> {
    const parsed = publicPage.safeParse(input);
    if (!parsed.success) throw new BadRequestException(PUBLIC_OUTFIT.failure.page);
    const {limit, ...filter} = parsed.data;
    const rows = await this.outfits.findPublishedPage({ ...filter, limit: limit + PUBLIC_OUTFIT.limits.overflow });
    const page = rows.slice(PUBLIC_OUTFIT.limits.first, limit);
    const productIds = this.uniqueShoppableProductIds(page.flatMap(detail => detail.items));
    const products = await this.products.findActiveByIds(productIds);
    return {
      items: page.map((detail) => this.toOutfitCard(detail, products)),
      nextCursor: rows.length > limit ? page.at(PUBLIC_OUTFIT.limits.last)!.outfit.id : null
    };
  }

  async getPublicDetail(outfitId: string): Promise<OutfitDetailDto> {
    const detail = await this.requireOutfit(outfitId);
    if (detail.outfit.status !== PUBLIC_OUTFIT.status || !PUBLIC_OUTFIT_VISIBILITIES.some(visibility => visibility === detail.outfit.visibility) ||
        (detail.outfit.creatorId !== null && detail.outfit.brandId !== null) ||
        ((detail.outfit.creatorId !== null || detail.outfit.brandId !== null) && detail.author === null)) {
      throw new NotFoundException(PUBLIC_OUTFIT.failure.missing);
    }
    return this.toOutfitDetail(detail, await this.products.findActiveByIds(this.uniqueShoppableProductIds(detail.items)));
  }

  toOutfitCard(detail: OutfitDetail, products: ProductDetail[]): OutfitCardDto {
    const byId = new Map(products.map(product => [product.product.id, product]));
    return {
      id: detail.outfit.id,
      title: detail.outfit.title,
      coverImageUrl: detail.outfit.coverImageUrl,
      prices: this.priceGroups(detail.items, products),
      author: detail.author,
      creatorId: detail.outfit.creatorId,
      brandId: detail.outfit.brandId,
      publishedAt: detail.outfit.publishedAt?.toISOString() ?? null,
      pins: detail.pins,
      images: [...detail.images].sort((a, b) => a.position - b.position).map(image => ({id: image.id, url: image.url, position: image.position})),
      items: detail.items
        .sort((a, b) => a.position - b.position)
        .map((item) => {
          const product = item.productId ? byId.get(item.productId) : undefined;
          return {
            id: item.id,
            itemType: item.itemType,
            label: product?.product.name ?? item.externalLabel ?? OUTFIT_EDITING.labels.unavailable,
            position: item.position,
            isRequired: item.isRequired,
            isShoppable: item.isShoppable,
            stylingNote: item.stylingNote,
            product: product
              ? {
                  id: product.product.id,
                  name: product.product.name,
                  brandId: product.product.brandId,
                  brandName: product.brand.brandName,
                  price: this.minProductPrice(product),
                  currency: product.product.currency,
                  imageUrl: product.images.sort((a, b) => a.position - b.position)[0]?.url ?? null
                }
              : null
          };
        })
    };
  }

  toOutfitDetail(detail: OutfitDetail, products: ProductDetail[]): OutfitDetailDto {
    return {...this.toOutfitCard(detail, products), description: detail.outfit.description};
  }

  private priceGroups(items: OutfitItem[], products: ProductDetail[]): OutfitPriceDto[] {
    const selectedIds = new Set(this.uniqueShoppableProductIds(items));
    const groups = new Map<string, OutfitPriceDto>();
    for (const detail of products) {
      if (!selectedIds.has(detail.product.id)) continue;
      const prices = detail.variants.filter(variant => variant.status === 'active')
        .map(variant => variant.priceOverride ?? detail.product.basePrice);
      const minimum = prices.length ? Math.min(...prices) : detail.product.basePrice;
      const maximum = prices.length ? Math.max(...prices) : detail.product.basePrice;
      const group = groups.get(detail.product.currency);
      if (group) { group.min += minimum; group.max += maximum; }
      else { groups.set(detail.product.currency, { currency: detail.product.currency, min: minimum, max: maximum }); }
    }
    return [...groups.values()].sort((left, right) => left.currency.localeCompare(right.currency));
  }

  private uniqueShoppableProductIds(items: Array<{ productId?: string | null; isShoppable: boolean }>): string[] {
    return [...new Set(items.filter((item) => item.isShoppable && item.productId).map((item) => item.productId as string))];
  }

  private minProductPrice(product: ProductDetail): number {
    const activeVariantPrices = product.variants
      .filter((variant) => variant.status === 'active')
      .map((variant) => variant.priceOverride ?? product.product.basePrice);
    return activeVariantPrices.length ? Math.min(...activeVariantPrices) : product.product.basePrice;
  }

  private async requireOutfit(outfitId: string, repository: OutfitRepository = this.outfits): Promise<OutfitDetail> {
    const detail = await repository.findById(outfitId);
    if (!detail) {
      throw new NotFoundException(OUTFIT_EDITING.failure.missing);
    }
    return detail;
  }
}
