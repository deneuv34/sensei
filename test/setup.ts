// Global test guard: the real embedding model must NEVER load in tests.
// Forbidding both remote AND local model loading makes warmupEmbedder fail
// fast with EmbeddingsUnavailable (deterministic regardless of any cached
// weights), so scan/context exercise their graceful lexical-only fallback.
// Tests that need the semantic path (embed-scan, embed-context) vi.mock the
// model module entirely, so these flags don't affect them.
import { env } from '@xenova/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = false;
