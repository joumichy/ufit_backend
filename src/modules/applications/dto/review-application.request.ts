import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { ApplicationDecision } from '../types/application.types';

const decisions: ApplicationDecision[] = ['accept', 'reject', 'waitlist', 'needs_more_info'];

export class ReviewApplicationRequest {
  @IsIn(decisions)
  decision!: ApplicationDecision;

  @IsOptional()
  @IsString()
  @Length(2, 2000)
  notes?: string;
}
