import {Inject, Injectable, NotFoundException} from '@nestjs/common';
import {requireBrandManagementAccess} from '../../brands/brand-management-access';
import {BRAND_ORDERS, type BrandOrderQuery} from '../domain/brand-order.contract';
import type {BrandOrderRepository} from '../domain/brand-order.repository';
import type {AuthenticatedUser} from '../../identity/domain/user.types';

@Injectable()
export class BrandOrdersService {
  constructor(@Inject(BRAND_ORDERS.repository) private readonly orders: BrandOrderRepository) {}
  list(actor: Pick<AuthenticatedUser, 'id'>, brandId: string, query: BrandOrderQuery) {
    return this.orders.snapshot(async repository => {
      requireBrandManagementAccess(await repository.findManagementAccess(brandId, actor.id));
      return repository.list(brandId, query);
    });
  }
  detail(actor: Pick<AuthenticatedUser, 'id'>, brandId: string, id: string) {
    return this.orders.snapshot(async repository => {
      requireBrandManagementAccess(await repository.findManagementAccess(brandId, actor.id));
      const order = await repository.detail(brandId, id);
      if (!order) throw new NotFoundException(BRAND_ORDERS.failure.missing);
      return order;
    });
  }
}
