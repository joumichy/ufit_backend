import { Transform } from "class-transformer";
import { trimApplicationText } from "./application-text";
import { IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { APPLICATION, APPLICATION_DECISIONS } from "../types/application-contract";
import type { ApplicationDecision } from '../types/application.types';


export class ReviewApplicationRequest {
  @IsInt() @Min(APPLICATION.limits.initialVersion)
  expectedVersion!: number;
  @IsIn(APPLICATION_DECISIONS)
  decision!: ApplicationDecision;

  @IsOptional()
  @IsString()
  @Transform(trimApplicationText)
  @Length(APPLICATION.limits.detailMin, APPLICATION.limits.textMax)
  notes?: string;
}
