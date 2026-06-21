import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

export class EmbeddingsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsUnavailable';
  }
}

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Load and cache the ONNX model. Idempotent. Throws EmbeddingsUnavailable on failure. */
export async function warmupEmbedder(cacheDir: string): Promise<void> {
  if (extractor) return;
  if (!initPromise) {
    env.cacheDir = cacheDir;
    initPromise = pipeline('feature-extraction', EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
  }
  try {
    extractor = await initPromise;
  } catch (err) {
    initPromise = null;
    throw new EmbeddingsUnavailable(`could not load embedding model: ${(err as Error).message}`);
  }
}

/** Embed texts into mean-pooled, L2-normalized vectors. Requires a prior warmupEmbedder. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!extractor) throw new EmbeddingsUnavailable('embedder not initialized; call warmupEmbedder first');
  if (texts.length === 0) return [];
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return (output.tolist() as number[][]).map((row) => Float32Array.from(row));
}
