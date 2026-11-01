import type {BrandManagementAccess} from '../../brands/brands.repository';
import type {Shipment, ShipmentChange, ShipmentContext} from './shipping.contract';

export interface ShipmentRepository {
  transaction<T>(operation: (repository: ShipmentRepository) => Promise<T>): Promise<T>;
  create(shipment: Shipment): Promise<Shipment>;
  findByOrderId(orderId: string): Promise<Shipment | null>;
  findById(id: string): Promise<Shipment | null>;
  lockManagementAccess(brandId: string, actorId: string): Promise<BrandManagementAccess | undefined>;
  lockContext(id: string): Promise<ShipmentContext | null>;
  apply(change: ShipmentChange, expectedVersion: number): Promise<void>;
}
