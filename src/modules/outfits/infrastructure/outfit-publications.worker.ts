import {BadRequestException, Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy} from '@nestjs/common';
import {OUTFIT_PUBLICATION as P} from '../domain/outfit-publication.contract';
import {OUTFIT_REPOSITORY, type OutfitRepository} from '../domain/outfit.types';
import {OutfitsService} from '../application/outfits.service';

@Injectable()
export class OutfitPublicationsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(OUTFIT_REPOSITORY) private readonly repository: OutfitRepository,
    @Inject(OutfitsService) private readonly service: Pick<OutfitsService, 'publishScheduledOutfit'>) {}
  onApplicationBootstrap(): void { this.schedule(); }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.processDue();
      void this.running.then(() => this.schedule(), () => this.schedule());
    }, P.clock.pollMs);
    this.timer.unref();
  }
  async processDue(): Promise<void> {
    const now = new Date();
    let cursor: string | undefined;
    while (!this.stopped) {
      const ids = await this.repository.listDuePublications(now, cursor);
      if (!ids.length) return;
      for (const id of ids) {
        if (this.stopped) return;
        try { await this.service.publishScheduledOutfit(id, now); }
        catch (error) {
          // Ineligible content stays private and is rechecked on the next pass.
          if (!(error instanceof BadRequestException)) throw error;
        }
      }
      cursor = ids.at(P.clock.last);
      if (ids.length < P.clock.batch) return;
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
