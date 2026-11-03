import {BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {ADMIN_ORDERS as A, adminOrderIdSchema, adminOrderQuerySchema, adminOrderReturnsQuerySchema, type AdminOrderRepository} from '../domain/admin-orders.contract';

@Injectable()
export class AdminOrdersService {
  constructor(@Inject(A.repository) private readonly orders: AdminOrderRepository) {}
  list(actorId: string, raw: unknown) {
    const query = parse(adminOrderQuerySchema, raw);
    return this.authorized(actorId, repository => repository.page(query));
  }
  detail(actorId: string, id: string) {
    const orderId = parse(adminOrderIdSchema, id);
    return this.authorized(actorId, repository => requireOrder(repository, orderId));
  }
  relatedReturns(actorId: string, id: string, raw: unknown) {
    const orderId = parse(adminOrderIdSchema, id), query = parse(adminOrderReturnsQuerySchema, raw);
    return this.authorized(actorId, async repository => {
      await requireOrder(repository, orderId);
      return repository.relatedReturns(actorId, orderId, query);
    });
  }
  private authorized<T>(actorId: string, operation: (repository: AdminOrderRepository) => Promise<T>) {
    return this.orders.snapshot(async repository => {
      if (!isUserAdministrator(await repository.access(actorId))) throw new ForbiddenException(A.failure.access);
      return operation(repository);
    });
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException(A.failure.input);
  return result.data;
}
async function requireOrder(repository: AdminOrderRepository, id: string) {
  const order = await repository.detail(id);
  if (!order) throw new NotFoundException(A.failure.missing);
  return order;
}
