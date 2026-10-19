/** Workers AI embeddings (bge-base-en-v1.5, CLS pooling) behind an interface the tests replace. */
import { EMBEDDING_DIMENSIONS, EMBED_MODEL } from "./intent";

export interface Embedder {
  /** One 768-dimension vector per input text, in order. Throws if any text cannot be embedded. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Texts per Workers AI call. The model supports batching; the maximum array size is not documented, so stay small. */
export const MAX_EMBED_BATCH = 25;

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_DIMENSIONS && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function workersAiEmbedder(ai: Ai): Embedder {
  return {
    async embed(texts) {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
        const chunk = texts.slice(i, i + MAX_EMBED_BATCH);
        const result = (await ai.run(EMBED_MODEL, { text: chunk, pooling: "cls" })) as { data?: unknown } | null;
        const data = result?.data;
        if (!Array.isArray(data) || data.length !== chunk.length || !data.every(validVector)) {
          throw new Error("Workers AI returned an unexpected embedding shape");
        }
        vectors.push(...(data as number[][]));
      }
      return vectors;
    },
  };
}

/** Builds the text for a given budget scale (1 = full, 0.5 = the retry after a failure). */
export type TextBuilder = (scale: number) => string;

/**
 * Embeds many texts. Tries one batch first; if it fails, embeds each text on
 * its own, retrying once with halved budgets, so one bad text never blocks the
 * rest. A text that still fails comes back as null.
 */
export async function embedMany(embedder: Embedder, builders: readonly TextBuilder[]): Promise<Array<number[] | null>> {
  if (builders.length === 0) return [];
  try {
    return await embedder.embed(builders.map((build) => build(1)));
  } catch (error) {
    if (builders.length > 1) console.error("achromat-mom embedding batch failed, retrying one by one", error instanceof Error ? error.message : error);
  }
  const out: Array<number[] | null> = [];
  for (const build of builders) {
    let vector: number[] | null = null;
    for (const scale of [1, 0.5]) {
      try {
        vector = (await embedder.embed([build(scale)]))[0] ?? null;
        break;
      } catch (error) {
        console.error("achromat-mom embedding failed", scale, error instanceof Error ? error.message : error);
      }
    }
    out.push(vector);
  }
  return out;
}

/** Embeds one text with the same halved-budget retry. Throws if both attempts fail. */
export async function embedOne(embedder: Embedder, build: TextBuilder): Promise<number[]> {
  const [vector] = await embedMany(embedder, [build]);
  if (!vector) throw new Error("embedding failed");
  return vector;
}
