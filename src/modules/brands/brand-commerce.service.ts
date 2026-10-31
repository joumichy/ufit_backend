import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { BRANDS_REPOSITORY } from "./brands.tokens";
import type { BrandsRepository } from "./brands.repository";
import { BrandsService } from "./brands.service";
import {
  brandCommercePolicySchema,
  COMMERCE_POLICY_KEY,
  type BrandCommercePolicy,
} from "./commerce-policy";
import type { AuthenticatedUser } from "../identity/domain/user.types";

const POLICY_FAILURE = {
  input: {
    code: "brand_policy_invalid",
    message: "Invalid brand commerce policy",
  },
  persisted: {
    code: "brand_policy_invalid",
    message: "The brand commerce policy requires correction",
  },
} as const;
@Injectable()
export class BrandCommerceService {
  constructor(
    @Inject(BRANDS_REPOSITORY) private readonly brands: BrandsRepository,
    @Inject(BrandsService) private readonly profiles: BrandsService,
  ) {}
  async read(brandID: string): Promise<BrandCommercePolicy | null> {
    await this.profiles.getPublicProfile(brandID);
    const settings = await this.brands.findSettings(brandID);
    const raw = settings?.metadata[COMMERCE_POLICY_KEY];
    if (raw === undefined) return null;
    const parsed = brandCommercePolicySchema.safeParse(raw);
    if (!parsed.success) throw new ConflictException(POLICY_FAILURE.persisted);
    return parsed.data;
  }
  async update(
    brandID: string,
    actor: AuthenticatedUser,
    input: unknown,
  ): Promise<BrandCommercePolicy> {
    if (
      !actor.roles.includes("admin") &&
      !actor.roles.includes("super_admin")
    ) {
      await this.profiles.getProfileForMember(brandID, actor.id);
    }
    await this.profiles.getPublicProfile(brandID);
    const policy = brandCommercePolicySchema.safeParse(input);
    if (!policy.success) throw new BadRequestException(POLICY_FAILURE.input);
    await this.brands.saveCommercePolicy(brandID, policy.data);
    return (await this.read(brandID))!;
  }
}
