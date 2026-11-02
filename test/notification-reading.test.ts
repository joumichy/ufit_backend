import {describe,expect,it} from 'vitest';
import {notificationDestinationSchema,notificationDetailSchema} from '../src/modules/notifications/domain/notification-reading';
const FIXTURE={id:'8de392a4-9161-4000-a927-57b826ce9d9a',other:'8de392a4-9161-4000-a927-57b826ce9d9b',createdAt:'2026-11-02T00:00:00.000Z'} as const;
describe('Private notification response boundary',()=>{
  it.each([
    {kind:'creator_application',id:FIXTURE.id},{kind:'brand_application',id:FIXTURE.id},
    {kind:'customer_order',id:FIXTURE.id},{kind:'brand_order',id:FIXTURE.id,brandId:FIXTURE.other},
    {kind:'customer_return',id:FIXTURE.id,orderId:FIXTURE.other},{kind:'brand_return',id:FIXTURE.id,brandId:FIXTURE.other},
  ])('emits exactly the scope required by $kind',destination=>{
    const detail={id:FIXTURE.id,subject:'Qualification',text:'Consultez votre dossier.',createdAt:FIXTURE.createdAt,destination};
    expect(notificationDetailSchema.parse(detail)).toEqual(detail);
  });
  it.each([
    {kind:'customer_order',id:FIXTURE.id,brandId:FIXTURE.other},
    {kind:'brand_order',id:FIXTURE.id},
    {kind:'customer_return',id:FIXTURE.id},
    {kind:'brand_return',id:FIXTURE.id,brandId:FIXTURE.other,orderId:FIXTURE.id},
    {kind:'administrator_order',id:FIXTURE.id},{kind:'customer_order',id:'invalid'},
  ])('rejects unknown or conflicting scope without guessing another destination: %j',destination=>{
    expect(notificationDestinationSchema.safeParse(destination).success).toBe(false);
  });
});
