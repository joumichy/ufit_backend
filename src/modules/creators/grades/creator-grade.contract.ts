import {z} from 'zod';

export const CREATOR_GRADE = {
  initialCode: 'seed', initialReason: 'application_accepted',
  token: {repository: 'CreatorGradeRepository'},
  route: {
    definitions: 'admin/creator-grades', assignments: 'admin/creator-grade-assignments',
    code: ':code', revisions: ':code/revisions', gradeHistory: ':code/history',
    creator: ':creatorId', changes: ':creatorId/changes', assignmentHistory: ':creatorId/history',
    codeParameter: 'code', creatorParameter: 'creatorId',
  },
  roles: ['admin', 'super_admin'],
  status: {activeUser: 'active', assignableCreator: ['active', 'paused']},
  boolean: {yes: 'true', no: 'false'},
  changeSource: {application: 'application', administration: 'administration'},
  persistence: {lock: 'update', wildcard: '%', literalPattern: /[\\%_]/g, escapedLiteral: '\\$&'},
  limits: {
    zero: 0, initialVersion: 1, increment: 1, first: 0, single: 1,
    maximumInteger: 2_147_483_647, code: 80, label: 120, reason: 500,
    search: 100, page: 20, maximumPage: 100,
  },
  codePattern: /^[a-z][a-z0-9-]*$/,
  failure: {
    input: 'Les paramètres du grade sont invalides.',
    access: 'Cet accès est réservé à une administration active.',
    missing: 'Ce grade est introuvable.',
    creatorMissing: 'Ce créateur est introuvable.',
    unavailableCreator: 'Ce compte créateur ne peut pas changer de grade dans son état actuel.',
    unavailableGrade: 'Ce grade ne peut plus être attribué.',
    initial: 'Le grade initial doit rester attribuable.',
    occupied: 'Ce code de grade est déjà utilisé.',
    changed: 'Ce grade a changé. Actualisez sa version avant de réessayer.',
    assignmentChanged: 'Le grade de ce créateur a changé. Actualisez avant de réessayer.',
    unchanged: 'Ce créateur possède déjà ce grade.',
    cursor: 'La page de grades demandée est invalide.',
    persisted: 'Les données de grade enregistrées sont incohérentes.',
    versionLimit: 'La limite de version de ce grade est atteinte.',
  },
} as const;

export const creatorGradeCodeSchema = z.string().min(CREATOR_GRADE.limits.single)
  .max(CREATOR_GRADE.limits.code).regex(CREATOR_GRADE.codePattern).refine(value => value === value.trim());
const integer = z.number().int().min(CREATOR_GRADE.limits.zero).max(CREATOR_GRADE.limits.maximumInteger);
const version = z.number().int().min(CREATOR_GRADE.limits.initialVersion).max(CREATOR_GRADE.limits.maximumInteger);
const reason = z.string().trim().min(CREATOR_GRADE.limits.single).max(CREATOR_GRADE.limits.reason);
const configuration = {
  label: z.string().trim().min(CREATOR_GRADE.limits.single).max(CREATOR_GRADE.limits.label),
  rank: integer, assignable: z.boolean(), reason,
};
export const createCreatorGradeSchema = z.object({code: creatorGradeCodeSchema, ...configuration}).strict();
export const reviseCreatorGradeSchema = z.object({expectedVersion: version, ...configuration}).strict();
export const changeCreatorGradeSchema = z.object({gradeCode: creatorGradeCodeSchema, expectedVersion: version, reason}).strict();

const page = {
  limit: z.coerce.number().int().min(CREATOR_GRADE.limits.single).max(CREATOR_GRADE.limits.maximumPage).default(CREATOR_GRADE.limits.page),
};
const search = z.string().trim().max(CREATOR_GRADE.limits.search).optional();
export const creatorGradePageSchema = z.object({
  ...page, cursor: creatorGradeCodeSchema.optional(), search,
  assignable: z.enum([CREATOR_GRADE.boolean.yes, CREATOR_GRADE.boolean.no])
    .transform(value => value === CREATOR_GRADE.boolean.yes).optional(),
}).strict();
export const creatorGradeHistoryPageSchema = z.object({...page, cursor: z.uuid().optional()}).strict();
export const creatorGradeAssignmentPageSchema = z.object({...page, cursor: z.uuid().optional(), search}).strict();

export type CreateCreatorGrade = z.infer<typeof createCreatorGradeSchema>;
export type ReviseCreatorGrade = z.infer<typeof reviseCreatorGradeSchema>;
export type ChangeCreatorGrade = z.infer<typeof changeCreatorGradeSchema>;
export type CreatorGradeQuery = z.infer<typeof creatorGradePageSchema>;
export type CreatorGradeHistoryQuery = z.infer<typeof creatorGradeHistoryPageSchema>;
export type CreatorGradeAssignmentQuery = z.infer<typeof creatorGradeAssignmentPageSchema>;

export interface CreatorGradeDefinition {
  code: string; label: string; rank: number; assignable: boolean; isInitial: boolean;
  version: number; revisionId: string; assignedCreators: number;
  createdAt: string; updatedAt: string | null;
}
export interface CreatorGradeRevision {
  id: string; code: string; version: number; previousRevisionId: string | null;
  label: string; rank: number; assignable: boolean;
  changedByUserId: string | null; reason: string | null; recordedAt: string;
}
export interface CreatorGradeAssignment {
  creatorId: string; displayName: string; slug: string; creatorStatus: string; accountStatus: string;
  gradeCode: string; gradeLabel: string; gradeRank: number; version: number;
}
export interface CreatorGradeChange {
  id: string; creatorId: string; version: number | null;
  source: typeof CREATOR_GRADE.changeSource[keyof typeof CREATOR_GRADE.changeSource] | null;
  fromGradeCode: string | null; fromGradeLabel: string | null; toGradeCode: string; toGradeLabel: string | null;
  changedByUserId: string | null; reason: string | null; createdAt: string;
}
export interface CreatorGradeChangeResult {assignment: CreatorGradeAssignment; change: CreatorGradeChange;}
export interface CreatorGradePage<T> {items: T[]; nextCursor: string | null;}
