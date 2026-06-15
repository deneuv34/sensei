import { z } from 'zod';

export const ReuseCandidateSchema = z.object({
  path: z.string(),
  line: z.number(),
  name: z.string(),
  kind: z.string(),
  signature: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
});

export const DangerousFileSchema = z.object({
  path: z.string(),
  importerCount: z.number(),
  reason: z.string(),
});

export const ContextReportSchema = z.object({
  task: z.string(),
  generatedAt: z.string(),
  reuseCandidates: z.array(ReuseCandidateSchema),
  dangerousFiles: z.array(DangerousFileSchema),
  agentRules: z.array(z.string()),
});
