import {describe, expect, it} from 'vitest';
import {
  changeCreatorGradeSchema, createCreatorGradeSchema, creatorGradeAssignmentPageSchema,
  creatorGradeHistoryPageSchema, creatorGradePageSchema, reviseCreatorGradeSchema,
} from '../../src/modules/creators/grades/creator-grade.contract';

const proposal = {code: 'curation-studio', label: 'Studio', rank: 2, assignable: true, reason: 'Ouverture de ce statut professionnel.'};
const invalidCodes = [' Studio ', 'STUDIO', proposal.code + '\n'];

describe('creator grade administration contract', () => {
  it('accepts explicit grade metadata without a global commission rate', () => {
    expect(createCreatorGradeSchema.parse(proposal)).toEqual(proposal);
    expect(() => createCreatorGradeSchema.parse({...proposal, commissionBps: 500})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, baseRateBps: 800})).toThrow();
  });

  it('keeps grade codes exact and requires a complete bounded configuration', () => {
    for (const code of invalidCodes) expect(() => createCreatorGradeSchema.parse({...proposal, code})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, rank: -1})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, rank: 1.5})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, rank: 2147483648})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, label: ' '})).toThrow();
    expect(() => createCreatorGradeSchema.parse({...proposal, reason: ' '})).toThrow();
    const incomplete = {code: proposal.code, label: proposal.label, rank: proposal.rank, reason: proposal.reason};
    expect(() => createCreatorGradeSchema.parse(incomplete)).toThrow();
  });

  it('requires a version for revision and prevents code or actor forgery', () => {
    const revision = {label: proposal.label, rank: proposal.rank, assignable: false, reason: proposal.reason, expectedVersion: 3};
    expect(reviseCreatorGradeSchema.parse(revision)).toEqual(revision);
    expect(() => reviseCreatorGradeSchema.parse({...revision, expectedVersion: 0})).toThrow();
    expect(() => reviseCreatorGradeSchema.parse({...revision, code: 'another-grade'})).toThrow();
    expect(() => reviseCreatorGradeSchema.parse({...revision, actorId: 'forged'})).toThrow();
    expect(() => reviseCreatorGradeSchema.parse({...revision, expectedVersion: undefined})).toThrow();
  });

  it('requires an explicit version and reason for assigning a creator grade', () => {
    const assignment = {gradeCode: proposal.code, expectedVersion: 4, reason: proposal.reason};
    expect(changeCreatorGradeSchema.parse(assignment)).toEqual(assignment);
    expect(() => changeCreatorGradeSchema.parse({...assignment, expectedVersion: 1.25})).toThrow();
    expect(() => changeCreatorGradeSchema.parse({...assignment, reason: ' '})).toThrow();
    expect(() => changeCreatorGradeSchema.parse({...assignment, creatorId: 'forged'})).toThrow();
  });

  it('parses false query filters as false and rejects unsupported boolean encodings', () => {
    expect(creatorGradePageSchema.parse({assignable: 'false'}).assignable).toBe(false);
    expect(creatorGradePageSchema.parse({assignable: 'true'}).assignable).toBe(true);
    expect(() => creatorGradePageSchema.parse({assignable: '0'})).toThrow();
    expect(creatorGradePageSchema.parse({cursor: proposal.code, limit: '1', search: ' Studio '}))
      .toEqual({cursor: proposal.code, limit: 1, search: 'Studio'});
  });

  it('separates definition-code cursors from assignment and revision identifiers', () => {
    expect(() => creatorGradeHistoryPageSchema.parse({cursor: proposal.code})).toThrow();
    expect(() => creatorGradeAssignmentPageSchema.parse({cursor: proposal.code})).toThrow();
    expect(() => creatorGradeAssignmentPageSchema.parse({limit: 101})).toThrow();
    expect(() => creatorGradePageSchema.parse({search: 's'.repeat(101)})).toThrow();
  });
});
