import {BadRequestException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {OutfitPublicationsWorker} from '../../src/modules/outfits/infrastructure/outfit-publications.worker';
import {OUTFIT_PUBLICATION as P} from '../../src/modules/outfits/domain/outfit-publication.contract';
import type {OutfitRepository} from '../../src/modules/outfits/domain/outfit.types';

const fixture = {idPrefix: 'scheduled-', blocked: 'blocked', unavailable: 'unavailable', second: 'second'} as const;
describe('Publication worker recovery', () => {
  it('continues after a blocked outfit and scans the next page instead of starving later publications', async () => {
    const first = Array.from({length: P.clock.batch}, (_, index) => fixture.idPrefix + index);
    const next = [fixture.second];
    const listDuePublications = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const publishScheduledOutfit = vi.fn(async (id: string) => {
      if (id === first[P.clock.first]) throw new BadRequestException(fixture.blocked);
      return true;
    });
    const worker = new OutfitPublicationsWorker({listDuePublications} as unknown as OutfitRepository, {publishScheduledOutfit});
    await worker.processDue();
    expect(publishScheduledOutfit.mock.calls.map(([id]) => id)).toEqual([...first, ...next]);
    expect(listDuePublications.mock.calls[P.clock.overflow][P.clock.overflow]).toBe(first.at(P.clock.last));
    await worker.onModuleDestroy();
  });
  it('does not mark an unexpected infrastructure failure as successful', async () => {
    const failure = new Error(fixture.unavailable);
    const listDuePublications = vi.fn().mockResolvedValue([fixture.second]);
    const publishScheduledOutfit = vi.fn().mockRejectedValue(failure);
    const worker = new OutfitPublicationsWorker({listDuePublications} as unknown as OutfitRepository, {publishScheduledOutfit});
    await expect(worker.processDue()).rejects.toBe(failure);
    expect(publishScheduledOutfit).toHaveBeenCalledWith(fixture.second, expect.any(Date));
    await worker.onModuleDestroy();
  });
});
