import type {BrandManagementAccess} from '../../brands/brands.repository';
import type {BrandOrderDetail, BrandOrderPage, BrandOrderQuery} from './brand-order.contract';

export interface BrandOrderRepository {
  snapshot<T>(operation: (repository: BrandOrderRepository) => Promise<T>): Promise<T>;
  findManagementAccess(brandId: string, actorId: string): Promise<BrandManagementAccess | undefined>;
  list(brandId: string, query: BrandOrderQuery): Promise<BrandOrderPage>;
  detail(brandId: string, id: string): Promise<BrandOrderDetail | undefined>;
}
