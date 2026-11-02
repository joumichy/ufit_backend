import {ForbiddenException,Inject,Injectable,InternalServerErrorException,NotFoundException} from '@nestjs/common';
import {and,eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {notifications,users,creatorApplications,brandApplications,orders,shipments,orderReturns} from '../../../shared/infrastructure/database/schema';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {requireBrandManagementAccess} from '../../brands/brand-management-access';
import {NOTIFICATION,notificationIntentSchema,type NotificationIntent} from '../domain/notification.contract';
import {NOTIFICATION_READING as READ,notificationDetailSchema,type NotificationDetail,type NotificationDestination} from '../domain/notification-reading';

type OrderReference={id:string;customerId:string;brandId:string};
const orderProjection={id:orders.id,customerId:orders.customerId,brandId:orders.brandId};

@Injectable()
export class DrizzleNotificationReader {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  read(actorId:string,id:string):Promise<NotificationDetail> {
    return this.database.db.transaction(async db=>{
      const [actor]=await db.select({status:users.status}).from(users).where(eq(users.id,actorId)).limit(NOTIFICATION.limits.minimum);
      if(!actor||!READ.account.readable.some(status=>status===actor.status))throw new ForbiddenException(READ.failure.inactive);
      const [row]=await db.select().from(notifications).where(and(eq(notifications.id,id),eq(notifications.recipientUserId,actorId))).limit(NOTIFICATION.limits.minimum);
      if(!row)throw new NotFoundException(READ.failure.missing);
      const parsed=notificationIntentSchema.safeParse({eventKey:row.eventKey,recipientUserId:row.recipientUserId,resourceType:row.resourceType,
        resourceId:row.resourceId,audience:row.audience,brandId:row.brandId,subject:row.subject,text:row.bodyText});
      if(!parsed.success)throw new InternalServerErrorException(READ.failure.persisted);
      const destination=await this.destination({db},parsed.data);
      return notificationDetailSchema.parse({id:row.id,subject:row.subject,text:row.bodyText,createdAt:row.createdAt.toISOString(),destination});
    },READ_SNAPSHOT);
  }
  private async destination(database:DatabaseSession,message:NotificationIntent):Promise<NotificationDestination> {
    const db=database.db,kind=READ.destination;
    switch(message.resourceType){
      case NOTIFICATION.resource.creatorApplication:{
        const [row]=await db.select({id:creatorApplications.id}).from(creatorApplications)
          .where(and(eq(creatorApplications.id,message.resourceId),eq(creatorApplications.userId,message.recipientUserId))).limit(NOTIFICATION.limits.minimum);
        if(!row)throw new NotFoundException(READ.failure.missing);
        return {kind:kind.creatorApplication,id:row.id};
      }
      case NOTIFICATION.resource.brandApplication:{
        const [row]=await db.select({id:brandApplications.id}).from(brandApplications)
          .where(and(eq(brandApplications.id,message.resourceId),eq(brandApplications.userId,message.recipientUserId))).limit(NOTIFICATION.limits.minimum);
        if(!row)throw new NotFoundException(READ.failure.missing);
        return {kind:kind.brandApplication,id:row.id};
      }
      case NOTIFICATION.resource.order:{
        const [reference]=await db.select(orderProjection).from(orders).where(eq(orders.id,message.resourceId)).limit(NOTIFICATION.limits.minimum);
        const order=await this.authorizeOrder(database,message,reference);
        return message.audience===NOTIFICATION.audience.customer?{kind:kind.customerOrder,id:order.id}:{kind:kind.brandOrder,id:order.id,brandId:order.brandId};
      }
      case NOTIFICATION.resource.shipment:{
        const [reference]=await db.select(orderProjection).from(shipments).innerJoin(orders,and(eq(orders.id,shipments.orderId),eq(orders.brandId,shipments.brandId)))
          .where(eq(shipments.id,message.resourceId)).limit(NOTIFICATION.limits.minimum);
        const order=await this.authorizeOrder(database,message,reference);
        return message.audience===NOTIFICATION.audience.customer?{kind:kind.customerOrder,id:order.id}:{kind:kind.brandOrder,id:order.id,brandId:order.brandId};
      }
      case NOTIFICATION.resource.orderReturn:{
        const [reference]=await db.select(orderProjection).from(orderReturns).innerJoin(orders,eq(orders.id,orderReturns.orderId))
          .where(eq(orderReturns.id,message.resourceId)).limit(NOTIFICATION.limits.minimum);
        const order=await this.authorizeOrder(database,message,reference);
        return message.audience===NOTIFICATION.audience.customer?{kind:kind.customerReturn,id:message.resourceId,orderId:order.id}
          :{kind:kind.brandReturn,id:message.resourceId,brandId:order.brandId};
      }
    }
  }
  private async authorizeOrder(database:DatabaseSession,message:NotificationIntent,order:OrderReference|undefined):Promise<OrderReference> {
    if(!order)throw new NotFoundException(READ.failure.missing);
    if(message.audience===NOTIFICATION.audience.customer){
      if(order.customerId!==message.recipientUserId)throw new NotFoundException(READ.failure.missing);
    }else{
      if(message.audience!==NOTIFICATION.audience.brand||message.brandId!==order.brandId)throw new NotFoundException(READ.failure.missing);
      requireBrandManagementAccess(await new DrizzleBrandsRepository(database).findManagementAccess(order.brandId,message.recipientUserId));
    }
    return order;
  }
}
