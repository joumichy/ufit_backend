import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA} from '@nestjs/common/constants';
import {ShippingAddressesService} from '../../src/modules/identity/application/shipping-addresses.service';
import {ShippingAddressesController} from '../../src/modules/identity/presentation/controllers/shipping-addresses.controller';
import {AuthGuard} from '../../src/shared/presentation/guards/auth.guard';
import {COUNTRY_CODES} from '../../src/shared/domain/countries';
import {SHIPPING_ADDRESSES as S, type ShippingAddressesRepository} from '../../src/modules/identity/domain/shipping-addresses.contract';
import {encodeShippingAddressCursor} from '../../src/modules/identity/domain/shipping-addresses.cursor';
const P = {actor: randomUUID(), other: randomUUID(), address: randomUUID(), request: randomUUID(), fullName: '  QA Ufit  ',
  line: 'Rue de qualification', postal: '1000', city: 'Lausanne', country: 'CH', invalid: 'invalid'} as const;
function setup() {
  const repository = {list: vi.fn(), find: vi.fn(), change: vi.fn(), apply: vi.fn()} satisfies ShippingAddressesRepository;
  return {repository, service: new ShippingAddressesService(repository)};
}
const save = () => ({expectedVersion: S.version.absent, action: S.action.save, addressId: P.address,
  shippingAddress: {fullName: P.fullName, line1: P.line, postalCode: P.postal, city: P.city, country: P.country}, makeDefault: false});
describe('Shipping address application ownership boundary', () => {
  it('refuses another owner before every repository access, including replay status', () => {
    const {repository, service} = setup();
    for (const run of [() => service.list(P.actor, P.other, {}), () => service.find(P.actor, P.other, P.address),
      () => service.change(P.actor, P.other, P.request), () => service.apply(P.actor, P.other, P.request, save())]) expect(run).toThrow();
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });
  it('sends only normalized canonical data and explicit account/request identity to persistence', () => {
    const {repository, service} = setup();
    service.apply(P.actor, P.actor.toUpperCase(), P.request.toUpperCase(), {...save(), addressId: P.address.toUpperCase()});
    expect(repository.apply).toHaveBeenCalledExactlyOnceWith(P.actor, P.request,
      {...save(), shippingAddress: {...save().shippingAddress, fullName: P.fullName.trim()}});
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('validates cursor ownership and query multiplicity before persistence', () => {
    const {repository, service} = setup();
    const cursor = {userId: P.actor, version: S.version.initial, afterId: P.address};
    service.list(P.actor, P.actor, {cursor: encodeShippingAddressCursor(cursor)});
    expect(repository.list).toHaveBeenCalledExactlyOnceWith(P.actor, {limit: S.pagination.default, cursor});
    expect(() => service.list(P.actor, P.actor, {cursor: encodeShippingAddressCursor({...cursor, userId: P.other})})).toThrow();
    expect(() => service.list(P.actor, P.actor, {limit: [S.pagination.default]})).toThrow();
    expect(repository.list).toHaveBeenCalledTimes(S.persistence.one);
  });
  it('rejects noncanonical IDs and missing default intent without writes', () => {
    const {repository, service} = setup();
    expect(() => service.apply(P.actor, P.actor, P.invalid, save())).toThrow();
    expect(() => service.apply(P.actor, P.actor, P.request, {...save(), makeDefault: undefined})).toThrow();
    expect(repository.apply).not.toHaveBeenCalled();
  });
});
describe('Shipping address transport boundary', () => {
  it('projects the same ISO authority and keeps every route authenticated and private', () => {
    const {service} = setup(), controller = new ShippingAddressesController(service);
    expect(controller.countries().countries).toBe(COUNTRY_CODES);
    expect(Reflect.getMetadata(GUARDS_METADATA, ShippingAddressesController)).toContain(AuthGuard);
    expect(Reflect.getMetadata(PATH_METADATA, controller.countries)).toBe(S.route.countries);
    for (const route of [controller.countries, controller.list, controller.find, controller.change, controller.apply])
      expect(Reflect.getMetadata(HEADERS_METADATA, route)).toContainEqual({name: S.cache.header, value: S.cache.value});
  });
});
