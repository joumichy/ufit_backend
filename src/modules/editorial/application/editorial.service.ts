import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OUTFIT_REPOSITORY, type OutfitRepository } from '../../outfits/domain/outfit.types';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../../products/domain/product.types';
import { EDITORIAL_REPOSITORY, type EditorialCollectionDetail, type EditorialRepository } from '../domain/editorial.types';
import { CreateEditorialCollectionDto } from './dto/editorial.dto';

@Injectable()
export class EditorialService {
  constructor(
    @Inject(EDITORIAL_REPOSITORY) private readonly editorial: EditorialRepository,
    @Inject(OUTFIT_REPOSITORY) private readonly outfits: OutfitRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository
  ) {}

  async createCollection(input: CreateEditorialCollectionDto): Promise<EditorialCollectionDetail> {
    this.assertItems(input.items ?? []);
    const collection = await this.editorial.createCollection({
      title: input.title,
      subtitle: input.subtitle ?? null,
      description: input.description,
      coverImageUrl: input.coverImageUrl ?? null,
      createdBy: input.createdBy
    });
    const items = input.items?.length
      ? await this.editorial.addItems(
          collection.id,
          input.items.map((item) => ({
            itemType: item.itemType,
            outfitId: item.outfitId ?? null,
            productId: item.productId ?? null,
            position: item.position
          }))
        )
      : [];
    return { collection, items };
  }

  publishCollection(collectionId: string): Promise<unknown> {
    return this.editorial.publishCollection(collectionId);
  }

  async getPublicCollections(limit = 10): Promise<EditorialCollectionDetail[]> {
    const collections = await this.editorial.findPublishedCollections(Math.min(Math.max(limit, 1), 50));
    return Promise.all(
      collections.map(async (detail) => ({
        collection: detail.collection,
        items: (
          await Promise.all(
            detail.items.map(async (item) => {
              if (item.itemType === 'outfit' && item.outfitId) {
                const outfit = await this.outfits.findById(item.outfitId);
                return outfit?.outfit.status === 'published' ? item : null;
              }
              if (item.itemType === 'product' && item.productId) {
                const product = await this.products.findById(item.productId);
                return product?.product.status === 'active' ? item : null;
              }
              return null;
            })
          )
        ).filter((item) => item !== null)
      }))
    );
  }

  private assertItems(items: Array<{ itemType: 'outfit' | 'product'; outfitId?: string; productId?: string }>): void {
    for (const item of items) {
      if (item.itemType === 'outfit' && (!item.outfitId || item.productId)) {
        throw new BadRequestException('Editorial outfit items require only outfitId');
      }
      if (item.itemType === 'product' && (!item.productId || item.outfitId)) {
        throw new BadRequestException('Editorial product items require only productId');
      }
    }
  }
}
