import {createHash} from 'node:crypto';
import {ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {and, asc, eq, gt} from 'drizzle-orm';
import {DatabaseService} from '../../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {users} from '../../../../shared/infrastructure/database/schema.identity';
import {shippingAddressBooks, shippingAddresses, shippingAddressChanges} from '../../../../shared/infrastructure/database/schema.shipping-addresses';
import {SHIPPING_ADDRESSES as S, shippingAddressItemSchema, shippingAddressPageSchema, shippingAddressReceiptSchema,
  type ShippingAddressChange, type ShippingAddressItem, type ShippingAddressListInput, type ShippingAddressPage,
  type ShippingAddressReceipt, type ShippingAddressesRepository} from '../../domain/shipping-addresses.contract';
import {encodeShippingAddressCursor} from '../../domain/shipping-addresses.cursor';

@Injectable()
export class DrizzleShippingAddressesRepository implements ShippingAddressesRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  list(userId: string, input: ShippingAddressListInput): Promise<ShippingAddressPage> {
    return this.database.db.transaction(async db => {
      await requireAccount({db}, userId, false);
      const [book] = await db.select().from(shippingAddressBooks).where(eq(shippingAddressBooks.userId, userId)).limit(S.persistence.one);
      const version = book?.version ?? S.version.absent;
      if (input.cursor && (input.cursor.userId !== userId || input.cursor.version !== version)) throw new ConflictException(S.failure.changed);
      const defaults = await db.select({id: shippingAddresses.id}).from(shippingAddresses)
        .where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.isDefault, true))).limit(S.persistence.one);
      const rows = await db.select().from(shippingAddresses).where(and(eq(shippingAddresses.userId, userId),
        input.cursor ? gt(shippingAddresses.id, input.cursor.afterId) : undefined)).orderBy(asc(shippingAddresses.id)).limit(input.limit + S.pagination.extra);
      const items = rows.slice(S.version.absent, input.limit).map(project);
      const nextCursor = rows.length > input.limit ? encodeShippingAddressCursor({userId, version, afterId: items[items.length - S.persistence.one].id}) : null;
      const result = shippingAddressPageSchema.safeParse({userId, version, defaultAddressId: defaults[S.version.absent]?.id ?? null, items, nextCursor});
      if (!result.success) throw new ServiceUnavailableException(S.failure.persisted);
      return result.data;
    }, READ_SNAPSHOT);
  }
  find(userId: string, addressId: string): Promise<ShippingAddressItem> {
    return this.database.db.transaction(async db => {
      await requireAccount({db}, userId, false);
      return project(await requireAddress({db}, userId, addressId));
    }, READ_SNAPSHOT);
  }
  change(userId: string, requestId: string): Promise<{receipt: ShippingAddressReceipt | null}> {
    return this.database.db.transaction(async db => {
      await requireAccount({db}, userId, false);
      const [row] = await db.select().from(shippingAddressChanges)
        .where(and(eq(shippingAddressChanges.userId, userId), eq(shippingAddressChanges.requestId, requestId))).limit(S.persistence.one);
      return {receipt: row ? projectReceipt(row) : null};
    }, READ_SNAPSHOT);
  }
  apply(userId: string, requestId: string, command: ShippingAddressChange): Promise<ShippingAddressReceipt> {
    const fingerprint = createHash(S.digest.algorithm).update(JSON.stringify(command)).digest(S.digest.encoding);
    return this.database.db.transaction(async db => {
      // Address edits and account erasure serialize on the same owning user row.
      await requireAccount({db}, userId, true);
      const [prior] = await db.select().from(shippingAddressChanges)
        .where(and(eq(shippingAddressChanges.userId, userId), eq(shippingAddressChanges.requestId, requestId))).limit(S.persistence.one);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException(S.failure.reused);
        return projectReceipt(prior);
      }
      const [book] = await db.select().from(shippingAddressBooks).where(eq(shippingAddressBooks.userId, userId)).limit(S.persistence.one);
      const previousVersion = book?.version ?? S.version.absent;
      if (previousVersion !== command.expectedVersion) throw new ConflictException(S.failure.changed);
      const version = previousVersion + S.version.step, now = new Date();
      if (!book) await db.insert(shippingAddressBooks).values({userId, version, updatedAt: now});
      await mutate({db}, userId, command, now);
      if (book) {
        const updated = await db.update(shippingAddressBooks).set({version, updatedAt: now})
          .where(and(eq(shippingAddressBooks.userId, userId), eq(shippingAddressBooks.version, command.expectedVersion)))
          .returning({userId: shippingAddressBooks.userId});
        if (updated.length !== S.persistence.one) throw new ConflictException(S.failure.changed);
      }
      const [receipt] = await db.insert(shippingAddressChanges).values({userId, requestId, fingerprint,
        expectedVersion: command.expectedVersion, version, action: command.action, addressId: command.addressId, createdAt: now}).returning();
      return projectReceipt(receipt);
    });
  }
}
async function requireAccount(database: DatabaseSession, userId: string, lock: boolean): Promise<void> {
  const query = database.db.select({status: users.status}).from(users).where(eq(users.id, userId)).limit(S.persistence.one);
  const [actor] = lock ? await query.for(S.persistence.lock) : await query;
  if (!actor || !S.persistence.statuses.some(status => status === actor.status)) throw new ForbiddenException(S.failure.unavailable);
}
async function requireAddress(database: DatabaseSession, userId: string, addressId: string) {
  const [address] = await database.db.select().from(shippingAddresses)
    .where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.id, addressId))).limit(S.persistence.one);
  if (!address) throw new NotFoundException(S.failure.missing);
  return address;
}
async function mutate(database: DatabaseSession, userId: string, command: ShippingAddressChange, now: Date): Promise<void> {
  const db = database.db;
  if (command.action === S.action.save) {
    const [previous] = await db.select().from(shippingAddresses)
      .where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.id, command.addressId))).limit(S.persistence.one);
    if (command.makeDefault) await clearDefault(database, userId);
    const address = command.shippingAddress;
    const value = {fullName: address.fullName, line1: address.line1, line2: address.line2 ?? null,
      postalCode: address.postalCode, city: address.city, country: address.country, phone: address.phone ?? null,
      isDefault: command.makeDefault || previous?.isDefault === true, updatedAt: now};
    if (previous) await db.update(shippingAddresses).set(value).where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.id, command.addressId)));
    else await db.insert(shippingAddresses).values({...value, userId, id: command.addressId, createdAt: now});
  } else if (command.action === S.action.delete) {
    await requireAddress(database, userId, command.addressId);
    await db.delete(shippingAddresses).where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.id, command.addressId)));
  } else {
    if (command.addressId !== null) await requireAddress(database, userId, command.addressId);
    await clearDefault(database, userId);
    if (command.addressId !== null) await db.update(shippingAddresses).set({isDefault: true})
      .where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.id, command.addressId)));
  }
}
async function clearDefault(database: DatabaseSession, userId: string): Promise<void> {
  await database.db.update(shippingAddresses).set({isDefault: false})
    .where(and(eq(shippingAddresses.userId, userId), eq(shippingAddresses.isDefault, true)));
}
function project(row: typeof shippingAddresses.$inferSelect): ShippingAddressItem {
  const parsed = shippingAddressItemSchema.safeParse({id: row.id, shippingAddress: {fullName: row.fullName,
    line1: row.line1, ...(row.line2 === null ? {} : {line2: row.line2}), postalCode: row.postalCode,
    city: row.city, country: row.country, ...(row.phone === null ? {} : {phone: row.phone})},
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()});
  if (!parsed.success) throw new ServiceUnavailableException(S.failure.persisted);
  return parsed.data;
}
function projectReceipt(row: typeof shippingAddressChanges.$inferSelect): ShippingAddressReceipt {
  const parsed = shippingAddressReceiptSchema.safeParse({requestId: row.requestId, action: row.action, version: row.version, addressId: row.addressId});
  if (!parsed.success) throw new ServiceUnavailableException(S.failure.persisted);
  return parsed.data;
}
