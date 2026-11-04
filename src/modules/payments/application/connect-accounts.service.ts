import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "../../../config/env";
import type { AuthenticatedUser } from "../../identity/domain/user.types";
import { BrandsService } from "../../brands/brands.service";
import { BRANDS_SERVICE } from "../../brands/brands.tokens";
import { CreatorsService } from "../../creators/creators.service";
import { CREATORS_SERVICE } from "../../creators/creators.tokens";
import type { StripePaymentsClient } from "./payments.service";
import { STRIPE_CLIENT } from "./stripe-commerce";
import {
  CONNECT,
  emptyConnectSnapshot,
  emptyConnectRequirements,
  type ConnectAccountRecord,
  type ConnectAccountStatus,
  type ConnectAccountsRepository,
  type ConnectScope,
  type ConnectSnapshot,
  type ConnectRequirements,
} from "../domain/connect-account";
import {
  connectSnapshot,
  connectRequirements,
  ensureStripeConnectAccount,
} from "../infrastructure/stripe-connect-accounts";
const countryRequest = z
  .object({ country: z.string().regex(CONNECT.countryPattern) })
  .strict();
const DEVELOPMENT = "development";
type ConnectSynchronizedState = { snapshot: ConnectSnapshot; requirements: ConnectRequirements };

@Injectable()
export class ConnectAccountsService {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripePaymentsClient | null,
    @Inject(CONNECT.repository)
    private readonly accounts: ConnectAccountsRepository,
    @Inject(BRANDS_SERVICE) private readonly brands: BrandsService,
    @Inject(CREATORS_SERVICE) private readonly creators: CreatorsService,
  ) {}
  private client(): StripePaymentsClient {
    if (!this.stripe)
      throw new ServiceUnavailableException(CONNECT.failure.unavailable);
    return this.stripe;
  }
  private liveMode(): boolean {
    const key = getEnv().STRIPE_SECRET_KEY;
    if (key && CONNECT.key.live.some((prefix) => key.startsWith(prefix)))
      return true;
    if (key && CONNECT.key.test.some((prefix) => key.startsWith(prefix)))
      return false;
    throw new ServiceUnavailableException(CONNECT.failure.unavailable);
  }
  private async authorize(
    scope: ConnectScope,
    actor: AuthenticatedUser,
  ): Promise<boolean> {
    if (scope.kind === CONNECT.kind.creator) {
      const profile = await this.creators.getOwnProfile(actor.id);
      if (
        profile.id !== scope.profileId ||
        profile.status !== CONNECT.profileActive
      )
        throw new ForbiddenException(CONNECT.failure.scope);
      return true;
    }
    const profile = await this.brands.getProfileForMember(
      scope.profileId,
      actor.id,
    );
    if (profile.status !== CONNECT.profileActive)
      throw new ForbiddenException(CONNECT.failure.scope);
    return profile.ownerUserId === actor.id;
  }
  async countries(): Promise<{ countries: string[] }> {
    const countries: string[] = [];
    for await (const spec of this.client().countrySpecs.list({
      limit: CONNECT.pageLimit,
    }))
      countries.push(spec.id);
    return { countries: countries.sort() };
  }
  async status(
    scope: ConnectScope,
    actor: AuthenticatedUser,
  ): Promise<ConnectAccountStatus> {
    const canConfigure = await this.authorize(scope, actor);
    const liveMode = this.liveMode();
    const record = await this.accounts.find(scope, liveMode);
    const state = record?.stripeAccountId
      ? await this.synchronize(record)
      : { snapshot: emptyConnectSnapshot(
          record ? CONNECT.stage.incomplete : CONNECT.stage.notStarted,
        ), requirements: emptyConnectRequirements() };
    return {
      ...scope,
      country: record?.country ?? null,
      liveMode,
      canConfigure,
      ...state.snapshot,
      requirements: state.requirements,
    };
  }
  async onboarding(
    scope: ConnectScope,
    actor: AuthenticatedUser,
    raw: unknown,
  ): Promise<{ url: string; expiresAt: number }> {
    if (!(await this.authorize(scope, actor)))
      throw new ForbiddenException(CONNECT.failure.owner);
    const parsed = countryRequest.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(CONNECT.failure.country);
    const stripe = this.client();
    const liveMode = this.liveMode();
    const { returnURL, refreshURL } = this.callbackURLs(liveMode);
    if (!(await this.countries()).countries.includes(parsed.data.country))
      throw new BadRequestException(CONNECT.failure.country);
    let record = await this.accounts.begin(
      scope,
      parsed.data.country,
      liveMode,
    );
    const account = await ensureStripeConnectAccount(stripe, record);
    record = await this.accounts.attach(record, account.id);
    await this.accounts.saveSnapshot(record, connectSnapshot(account, record));
    const link = await stripe.accountLinks.create({
      account: account.id,
      type: CONNECT.linkType,
      return_url: returnURL,
      refresh_url: refreshURL,
      collection_options: { fields: CONNECT.collectionFields },
    });
    return { url: link.url, expiresAt: link.expires_at };
  }
  async dashboard(
    scope: ConnectScope,
    actor: AuthenticatedUser,
  ): Promise<{ url: string }> {
    if (!(await this.authorize(scope, actor)))
      throw new ForbiddenException(CONNECT.failure.owner);
    const record = await this.accounts.find(scope, this.liveMode());
    if (!record?.stripeAccountId)
      throw new ConflictException(CONNECT.failure.scope);
    const link = await this.client().accounts.createLoginLink(
      record.stripeAccountId,
    );
    return { url: link.url };
  }
  private callbackURLs(liveMode: boolean) {
    const env = getEnv();
    const origin =
      env.API_ORIGIN ??
      (env.NODE_ENV === DEVELOPMENT
        ? `http://127.0.0.1:${env.API_PORT}`
        : undefined);
    if (
      !origin ||
      (liveMode && new URL(origin).protocol !== CONNECT.callback.secure)
    )
      throw new ServiceUnavailableException(CONNECT.failure.origin);
    return {
      returnURL: new URL(CONNECT.callback.returnPath, origin).href,
      refreshURL: new URL(CONNECT.callback.refreshPath, origin).href,
    };
  }
  private async synchronize(
    record: ConnectAccountRecord,
  ): Promise<ConnectSynchronizedState> {
    if (!record.stripeAccountId)
      return { snapshot: emptyConnectSnapshot(CONNECT.stage.incomplete), requirements: emptyConnectRequirements() };
    const account = await this.client().accounts.retrieve(record.stripeAccountId);
    const snapshot = connectSnapshot(
      account,
      record,
    );
    const requirements = connectRequirements(account);
    await this.accounts.saveSnapshot(record, snapshot);
    return { snapshot, requirements };
  }
  async accountUpdated(
    stripeAccountId: string,
    liveMode: boolean,
  ): Promise<void> {
    if (liveMode !== this.liveMode()) return;
    const record = await this.accounts.findByStripeId(
      stripeAccountId,
      liveMode,
    );
    if (record) await this.synchronize(record);
  }
  async assertSaleRecipients(
    brandId: string,
    creatorIds: string[],
  ): Promise<void> {
    const scopes: ConnectScope[] = [
      { kind: CONNECT.kind.brand, profileId: brandId },
      ...[...new Set(creatorIds)].map((profileId) => ({
        kind: CONNECT.kind.creator,
        profileId,
      })),
    ];
    for (const scope of scopes) {
      const record = await this.accounts.find(scope, this.liveMode());
      if (
        !record?.stripeAccountId ||
        (await this.synchronize(record)).snapshot.stage !== CONNECT.stage.ready
      )
        throw new ConflictException(CONNECT.failure.sale);
    }
  }
}
