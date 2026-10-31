import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BRANDS_SERVICE } from "../../brands/brands.tokens";
import { BrandsService } from "../../brands/brands.service";
import type { AuthenticatedUser } from "../../identity/domain/user.types";
export const SHIPMENT_STATUS = {
  pending: "pending",
  preparing: "preparing",
  shipped: "shipped",
  delivered: "delivered",
  failed: "failed",
  cancelled: "cancelled",
} as const;
export type ShipmentStatus =
  (typeof SHIPMENT_STATUS)[keyof typeof SHIPMENT_STATUS];
const SHIPPING_CONTRACT = {
  repository: "ShipmentRepository",
  admin: "admin",
  superAdmin: "super_admin",
  https: "https:",
  zero: 0,
  errors: {
    input: "Invalid shipment update",
    transition: "Invalid shipment transition",
    tracking: "Carrier and tracking number are required",
    missing: "Shipment not found",
  },
} as const;
export interface Shipment {
  id: string;
  orderId: string;
  brandId: string;
  status: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shippedAt?: string;
  deliveredAt?: string;
}
export interface ShipmentUpdate {
  nextStatus: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}
export interface ShipmentRepository {
  save(shipment: Shipment): Promise<Shipment>;
  findByOrderId(orderId: string): Promise<Shipment | null>;
  findById(id: string): Promise<Shipment | null>;
  transition(id: string, input: ShipmentUpdate): Promise<Shipment>;
}
const SHIPPING_FIELD = { minimum: 1, carrier: 120, tracking: 160 } as const;
const shipmentUpdateSchema = z
  .object({
    nextStatus: z.enum([
      SHIPMENT_STATUS.preparing,
      SHIPMENT_STATUS.shipped,
      SHIPMENT_STATUS.delivered,
      SHIPMENT_STATUS.failed,
    ]),
    carrier: z
      .string()
      .trim()
      .min(SHIPPING_FIELD.minimum)
      .max(SHIPPING_FIELD.carrier)
      .optional(),
    trackingNumber: z
      .string()
      .trim()
      .min(SHIPPING_FIELD.minimum)
      .max(SHIPPING_FIELD.tracking)
      .optional(),
    trackingUrl: z
      .url()
      .refine((value) => new URL(value).protocol === SHIPPING_CONTRACT.https)
      .optional(),
  })
  .strict();
export function assertShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): void {
  const allowed: Record<ShipmentStatus, ShipmentStatus[]> = {
    [SHIPMENT_STATUS.pending]: [
      SHIPMENT_STATUS.preparing,
      SHIPMENT_STATUS.failed,
    ],
    [SHIPMENT_STATUS.preparing]: [
      SHIPMENT_STATUS.shipped,
      SHIPMENT_STATUS.failed,
    ],
    [SHIPMENT_STATUS.shipped]: [
      SHIPMENT_STATUS.delivered,
      SHIPMENT_STATUS.failed,
    ],
    [SHIPMENT_STATUS.delivered]: [],
    [SHIPMENT_STATUS.failed]: [],
    [SHIPMENT_STATUS.cancelled]: [],
  };
  if (!allowed[from]?.includes(to))
    throw new BadRequestException(SHIPPING_CONTRACT.errors.transition);
}
export function applyShipmentUpdate(
  current: Shipment,
  input: ShipmentUpdate,
): Shipment {
  if (current.status === input.nextStatus) return current;
  assertShipmentTransition(current.status, input.nextStatus);
  const next = {
    ...current,
    status: input.nextStatus,
    carrier: input.carrier ?? current.carrier,
    trackingNumber: input.trackingNumber ?? current.trackingNumber,
    trackingUrl: input.trackingUrl ?? current.trackingUrl,
  };
  if (next.status === SHIPMENT_STATUS.shipped) {
    if (!next.carrier || !next.trackingNumber)
      throw new BadRequestException(SHIPPING_CONTRACT.errors.tracking);
    next.shippedAt ??= new Date().toISOString();
  }
  if (next.status === SHIPMENT_STATUS.delivered)
    next.deliveredAt ??= new Date().toISOString();
  return next;
}
@Injectable()
export class ShippingService {
  constructor(
    @Inject(SHIPPING_CONTRACT.repository)
    private readonly shipments: ShipmentRepository,
    @Inject(BRANDS_SERVICE) private readonly brands: BrandsService,
  ) {}
  createManualShipment(orderId: string, brandId: string): Shipment {
    return {
      id: randomUUID(),
      orderId,
      brandId,
      status: SHIPMENT_STATUS.pending,
    };
  }
  async createPendingForPaidOrder(
    orderId: string,
    brandId: string,
  ): Promise<Shipment> {
    return (
      (await this.shipments.findByOrderId(orderId)) ??
      this.shipments.save(this.createManualShipment(orderId, brandId))
    );
  }
  async updateForActor(
    actor: AuthenticatedUser,
    id: string,
    raw: unknown,
  ): Promise<Shipment> {
    const parsed = shipmentUpdateSchema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException(SHIPPING_CONTRACT.errors.input);
    const shipment = await this.shipments.findById(id);
    if (!shipment)
      throw new NotFoundException(SHIPPING_CONTRACT.errors.missing);
    if (
      !actor.roles.includes(SHIPPING_CONTRACT.admin) &&
      !actor.roles.includes(SHIPPING_CONTRACT.superAdmin)
    )
      await this.brands.getProfileForMember(shipment.brandId, actor.id);
    return this.shipments.transition(id, parsed.data);
  }
}
