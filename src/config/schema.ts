import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  include: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']),
  ignore: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.sensei/**',
    '**/*.d.ts',
  ]),
  context: z
    .object({ topN: z.number().int().positive().default(10) })
    .default({}),
  scoring: z
    .object({
      nameOverlap: z.number().default(0.4),
      pathMatch: z.number().default(0.2),
      exportedBoost: z.number().default(0.15),
      gitRecency: z.number().default(0.15),
      testExists: z.number().default(0.1),
    })
    .default({}),
  dangerous: z
    .object({ importerThreshold: z.number().int().positive().default(5) })
    .default({}),
});

export type SenseiConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: SenseiConfig = ConfigSchema.parse({});
