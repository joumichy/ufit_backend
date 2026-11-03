export const OUTFIT_PUBLICATION = {
  routes: {calendar: 'calendar', publication: ':id/publication'},
  clock: {pollMs: 30_000, batch: 50, zero: 0, first: 0, overflow: 1, last: -1, maxRangeDays: 62, dayMs: 86_400_000},
  timezone: {locale: 'en', maximumLength: 100},
  failure: {
    input: {code: 'outfit_publication_invalid', message: 'Choose a future publication date and an IANA time zone'},
    range: {code: 'outfit_calendar_range_invalid', message: 'Choose a calendar interval of at most 62 days'},
  },
} as const;

export interface OutfitPublicationInput {expectedVersion: number; scheduledFor: string | null; timeZone: string | null;}
export interface OutfitCalendarQuery {creatorId?: string; brandId?: string; from: Date; until: Date; cursor?: string; limit: number;}

export function validPublicationTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat(OUTFIT_PUBLICATION.timezone.locale, {timeZone: value}); return true; }
  catch { return false; }
}
