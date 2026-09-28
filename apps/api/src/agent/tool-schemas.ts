import { ACTIVE_ANNOTATION_KINDS } from '@walden/contracts';
import { z } from 'zod';

export const annotationKindSchema = z.enum(ACTIVE_ANNOTATION_KINDS);
// Limits are applied per candidate in `semanticAnnotations`, not here: one
// over-long quote from the model would otherwise fail the whole batch.
export const annotationCandidateSchema = z.object({
  quote: z.string().min(1),
  kind: annotationKindSchema,
  worthHighlighting: z.boolean(),
});
export const annotationOutputSchema = z.object({
  // Deciding that nothing is worth highlighting is a correct outcome, and a
  // model expresses it by returning no array at all. Without this default that
  // restraint fails schema validation and surfaces to the reader as an error.
  annotations: z.array(annotationCandidateSchema).default([]),
});
export const noteProposalOutputSchema = z.object({
  shouldPropose: z.boolean(),
  captureBasis: z.enum([
    'explicit_request',
    'user_decision',
    'user_constraint',
    'user_insight',
    'response_takeaway',
    'none',
  ]),
  mode: z.enum(['add', 'replace']),
  /** Id of a pending proposal this one supersedes, from the supplied list. */
  replaces: z.string().nullable().default(null),
  oldText: z.string(),
  newText: z.string(),
  reason: z.string().optional(),
});
export const noteProposalBatchOutputSchema = z.object({
  // As above: proposing nothing is a decision, not a malformed response.
  operations: z.array(noteProposalOutputSchema).max(3).default([]),
  reason: z.string().optional(),
});
export const noteProposalNoopSchema = z.object({ reason: z.string().min(1).max(240) });
const learningCheckQuestionSchema = z
  .string()
  .min(1)
  .max(500)
  .describe('One concrete recall or understanding question about the material itself.');
export const singleLearningCheckInputSchema = z.union([
  z
    .object({
      question: learningCheckQuestionSchema,
      options: z.array(z.string().min(1).max(240)).min(2).max(4),
    })
    .strict(),
  z.object({ question: learningCheckQuestionSchema }).strict(),
]);
const learningCheckPromptSchema = z.union([
  z
    .object({
      id: z.string().min(1).max(100).optional(),
      header: z.string().min(1).max(40).optional(),
      question: learningCheckQuestionSchema,
      options: z.array(z.string().min(1).max(240)).min(2).max(4),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(100).optional(),
      header: z.string().min(1).max(40).optional(),
      question: learningCheckQuestionSchema,
    })
    .strict(),
]);
export const learningCheckInputSchema = z
  .object({ questions: z.array(learningCheckPromptSchema).min(1).max(3) })
  .strict();

export type NoteProposalCandidate = z.infer<typeof noteProposalOutputSchema>;
export type AnnotationCandidate = z.infer<typeof annotationOutputSchema>['annotations'][number];
