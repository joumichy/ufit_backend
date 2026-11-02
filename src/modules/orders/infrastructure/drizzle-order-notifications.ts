import {NotFoundException} from '@nestjs/common';
import {and,eq,inArray} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders,brandMembers,users,userRoles} from '../../../shared/infrastructure/database/schema';
import {NOTIFICATION} from '../../notifications/domain/notification.contract';
import {DrizzleNotificationsRepository} from '../../notifications/infrastructure/drizzle-notifications.repository';
import {ORDER_NOTIFICATION,type OrderNotification} from '../domain/order-notification';

export class DrizzleOrderNotifications {
  constructor(private readonly database:DatabaseSession) {}
  async record(input:OrderNotification,includeBrand:boolean):Promise<void> {
    const [order]=await this.database.db.select({customerId:orders.customerId,brandId:orders.brandId})
      .from(orders).where(eq(orders.id,input.orderId)).limit(NOTIFICATION.limits.minimum);
    if(!order)throw new NotFoundException(NOTIFICATION.failure.missing);
    const writer=new DrizzleNotificationsRepository(this.database);
    const message={resourceType:input.resourceType,resourceId:input.resourceId,subject:input.subject,text:input.text};
    await writer.record({...message,eventKey:input.eventKey+ORDER_NOTIFICATION.event.separator+NOTIFICATION.audience.customer,
      recipientUserId:order.customerId,audience:NOTIFICATION.audience.customer,brandId:null});
    if(!includeBrand)return;
    const recipients=await this.database.db.select({id:brandMembers.userId}).from(brandMembers)
      .innerJoin(users,eq(users.id,brandMembers.userId)).innerJoin(userRoles,eq(userRoles.userId,users.id))
      .where(and(eq(brandMembers.brandProfileId,order.brandId),eq(brandMembers.status,ORDER_NOTIFICATION.recipient.memberActive),
        eq(users.status,ORDER_NOTIFICATION.recipient.active),inArray(userRoles.role,[...ORDER_NOTIFICATION.recipient.roles]))).groupBy(brandMembers.userId).orderBy(brandMembers.userId);
    for(const recipient of recipients)await writer.record({...message,
      eventKey:input.eventKey+ORDER_NOTIFICATION.event.separator+NOTIFICATION.audience.brand+ORDER_NOTIFICATION.event.separator+order.brandId,
      recipientUserId:recipient.id,audience:NOTIFICATION.audience.brand,brandId:order.brandId});
  }
}
