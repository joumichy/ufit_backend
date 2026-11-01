import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {CREATOR_GRADE} from './creator-grade.contract';
import {CreatorGradesService} from './creator-grades.service';

@Controller(CREATOR_GRADE.route.definitions)
@UseGuards(AuthGuard, AdminGuard)
export class CreatorGradeDefinitionsController {
  constructor(@Inject(CreatorGradesService) private readonly grades: CreatorGradesService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) { return this.grades.list(actor.id, query); }
  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) { return this.grades.create(actor.id, body); }
  @Get(CREATOR_GRADE.route.code)
  current(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.codeParameter) code: string) { return this.grades.current(actor.id, code); }
  @Get(CREATOR_GRADE.route.gradeHistory)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.codeParameter) code: string, @Query() query: unknown) {
    return this.grades.history(actor.id, code, query);
  }
  @Post(CREATOR_GRADE.route.revisions)
  revise(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.codeParameter) code: string, @Body() body: unknown) {
    return this.grades.revise(actor.id, code, body);
  }
}

@Controller(CREATOR_GRADE.route.assignments)
@UseGuards(AuthGuard, AdminGuard)
export class CreatorGradeAssignmentsController {
  constructor(@Inject(CreatorGradesService) private readonly grades: CreatorGradesService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) { return this.grades.assignments(actor.id, query); }
  @Get(CREATOR_GRADE.route.creator)
  current(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.creatorParameter, ParseUUIDPipe) id: string) {
    return this.grades.assignment(actor.id, id);
  }
  @Get(CREATOR_GRADE.route.assignmentHistory)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.creatorParameter, ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.grades.assignmentHistory(actor.id, id, query);
  }
  @Post(CREATOR_GRADE.route.changes)
  change(@CurrentUser() actor: AuthenticatedUser, @Param(CREATOR_GRADE.route.creatorParameter, ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.grades.change(actor.id, id, body);
  }
}
