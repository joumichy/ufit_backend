import {BadRequestException, Inject, Injectable} from '@nestjs/common';
import {z} from 'zod';
import {EDITORIAL as E, EDITORIAL_TRANSITIONS, editorialItemsPageSchema, editorialManagedPageSchema, editorialPageSchema,
  editorialTransitionSchema, editorialWriteSchema} from '../domain/editorial.contract';
import {EDITORIAL_REPOSITORY, type EditorialRepository} from '../domain/editorial.types';
@Injectable()
export class EditorialService {
  constructor(@Inject(EDITORIAL_REPOSITORY) private readonly editorial: EditorialRepository) {}
  createCollection(actorId: string, raw: unknown) {
    const input = parse(editorialWriteSchema, raw, E.failure.input);
    if (input.expectedVersion !== E.limits.zero) throw new BadRequestException(E.failure.input);
    return this.editorial.write({...input, actorId, collectionId: null, kind: E.command.create});
  }
  editCollection(actorId: string, collectionId: string, raw: unknown) {
    const input = parse(editorialWriteSchema, raw, E.failure.input);
    if (input.expectedVersion === E.limits.zero) throw new BadRequestException(E.failure.input);
    return this.editorial.write({...input, actorId, collectionId, kind: E.command.edit});
  }
  transition(actorId: string, collectionId: string, action: unknown, raw: unknown) {
    const input = parse(editorialTransitionSchema, raw, E.failure.input);
    const kind = parse(z.enum(EDITORIAL_TRANSITIONS), action, E.failure.input);
    return this.editorial.write({...input, actorId, collectionId, kind});
  }
  change(actorId: string, requestId: string) { return this.editorial.change(actorId, requestId); }
  managed(actorId: string, collectionId: string) { return this.editorial.managed(actorId, collectionId); }
  managedPage(actorId: string, raw: unknown) { return this.editorial.managedPage(actorId, parse(editorialManagedPageSchema, raw, E.failure.page)); }
  getPublicCollections(raw: unknown) { return this.editorial.publicPage(parse(editorialPageSchema, raw, E.failure.page)); }
  getPublicDetail(collectionId: string) { return this.editorial.publicDetail(collectionId); }
  getPublicItems(collectionId: string, raw: unknown) { return this.editorial.publicItems(collectionId, parse(editorialItemsPageSchema, raw, E.failure.page)); }
}
function parse<T extends z.ZodType>(schema: T, raw: unknown, failure: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException(failure);
  return parsed.data;
}
