import { describe, expect, it, vi } from "vitest";
import {
  applyShipmentUpdate,
  ShippingService,
  SHIPMENT_STATUS,
} from "../../src/modules/shipping/application/shipping.service";
import { InMemoryShipmentRepository } from "../../src/modules/shipping/infrastructure/in-memory-shipping.repository";
const fixture = {
  order: "order",
  brand: "brand",
  actor: { id: "brand-user", roles: ["brand_owner"] },
  carrier: "Poste de qualification",
  tracking: "QUALIFICATION",
  url: "https://example.test/tracking",
};
function setup() {
  const repository = new InMemoryShipmentRepository();
  const brands = {
    getProfileForMember: vi.fn().mockResolvedValue({ id: fixture.brand }),
  };
  return {
    repository,
    brands,
    service: new ShippingService(repository, brands as never),
  };
}
describe("ShippingService", () => {
  it("requires carrier and tracking when marking a persisted shipment shipped", async () => {
    const { service, repository } = setup();
    const shipment = await repository.save(
      service.createManualShipment(fixture.order, fixture.brand),
    );
    const preparing = await service.updateForActor(
      fixture.actor as never,
      shipment.id,
      { nextStatus: SHIPMENT_STATUS.preparing },
    );
    await expect(
      service.updateForActor(fixture.actor as never, shipment.id, {
        nextStatus: SHIPMENT_STATUS.shipped,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const shipped = await service.updateForActor(
      fixture.actor as never,
      preparing.id,
      {
        nextStatus: SHIPMENT_STATUS.shipped,
        carrier: fixture.carrier,
        trackingNumber: fixture.tracking,
        trackingUrl: fixture.url,
      },
    );
    expect(shipped).toMatchObject({
      status: SHIPMENT_STATUS.shipped,
      carrier: fixture.carrier,
      trackingNumber: fixture.tracking,
    });
    expect(shipped.shippedAt).toBeDefined();
  });
  it("checks membership against the stored brand, not a shipment supplied by the caller", async () => {
    const { service, repository, brands } = setup();
    const shipment = await repository.save(
      service.createManualShipment(fixture.order, fixture.brand),
    );
    await expect(
      service.updateForActor(fixture.actor as never, shipment.id, {
        nextStatus: SHIPMENT_STATUS.preparing,
        shipment: { brandId: "another-brand" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    brands.getProfileForMember.mockRejectedValueOnce(
      new Error("membership rejected"),
    );
    await expect(
      service.updateForActor(fixture.actor as never, shipment.id, {
        nextStatus: SHIPMENT_STATUS.preparing,
      }),
    ).rejects.toThrow("membership rejected");
    expect(brands.getProfileForMember).toHaveBeenCalledWith(
      fixture.brand,
      fixture.actor.id,
    );
    expect((await repository.findById(shipment.id))?.status).toBe(
      SHIPMENT_STATUS.pending,
    );
  });
  it("does not restart a cancelled shipment", () => {
    expect(() =>
      applyShipmentUpdate(
        {
          id: "shipment",
          orderId: fixture.order,
          brandId: fixture.brand,
          status: SHIPMENT_STATUS.cancelled,
        },
        { nextStatus: SHIPMENT_STATUS.preparing },
      ),
    ).toThrow();
  });
  it("reuses the paid-order shipment and makes the same transition idempotent", async () => {
    const { service } = setup();
    const first = await service.createPendingForPaidOrder(
      fixture.order,
      fixture.brand,
    );
    const second = await service.createPendingForPaidOrder(
      fixture.order,
      fixture.brand,
    );
    expect(second.id).toBe(first.id);
    const a = await service.updateForActor(fixture.actor as never, first.id, {
      nextStatus: SHIPMENT_STATUS.preparing,
    });
    const b = await service.updateForActor(fixture.actor as never, first.id, {
      nextStatus: SHIPMENT_STATUS.preparing,
    });
    expect(b).toEqual(a);
  });
});
