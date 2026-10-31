import { IsInt, Min } from "class-validator";
import { APPLICATION } from "../types/application-contract";
import { SubmitCreatorApplicationRequest } from "./submit-creator-application.request";
import { SubmitBrandApplicationRequest } from "./submit-brand-application.request";
export class ResubmitCreatorApplicationRequest extends SubmitCreatorApplicationRequest {
  @IsInt() @Min(APPLICATION.limits.initialVersion) expectedVersion!: number;
}
export class ResubmitBrandApplicationRequest extends SubmitBrandApplicationRequest {
  @IsInt() @Min(APPLICATION.limits.initialVersion) expectedVersion!: number;
}
