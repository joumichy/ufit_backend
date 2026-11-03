import {BadRequestException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {REFUND_RECOVERY, refundRecoveryCursorSchema, refundRecoveryKindSchema, refundRecoveryQuerySchema, type RefundRecoveryRepository} from '../domain/refund-recovery.contract';

@Injectable()
export class RefundRecoveryService {
  constructor(@Inject(REFUND_RECOVERY.repository) private readonly recovery: RefundRecoveryRepository) {}
  list(raw: unknown) {
    const input = refundRecoveryQuerySchema.safeParse(raw);
    if (!input.success) throw new BadRequestException(REFUND_RECOVERY.failure.input);
    let cursor: z.infer<typeof refundRecoveryCursorSchema> | undefined;
    if (input.data.cursor !== undefined) {
      try {
        const bytes = Buffer.from(input.data.cursor, REFUND_RECOVERY.cursorEncoding);
        if (bytes.toString(REFUND_RECOVERY.cursorEncoding) !== input.data.cursor) throw new Error();
        cursor = refundRecoveryCursorSchema.parse(JSON.parse(bytes.toString()));
        if (input.data.kind !== undefined && cursor.kind !== input.data.kind) throw new Error();
      } catch {throw new BadRequestException(REFUND_RECOVERY.failure.cursor);}
    }
    return this.recovery.list({limit: input.data.limit, kind: input.data.kind, search: input.data.search, cursor});
  }
  async detail(rawKind: string, rawId: string) {
    const kind = refundRecoveryKindSchema.safeParse(rawKind), id = z.uuid().safeParse(rawId);
    if (!kind.success || !id.success) throw new BadRequestException(REFUND_RECOVERY.failure.input);
    const result = await this.recovery.detail(kind.data, id.data);
    if (!result) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    return result;
  }
}
