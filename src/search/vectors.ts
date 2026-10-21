/**
 * Vectorize access behind an interface the tests replace.
 *
 * Domain is the namespace (gated before any metadata filter). Metadata is
 * exactly four short indexed strings and never lesson content, so Vectorize
 * cannot become a second, scrapeable copy of the ledger.
 */
import type { Env } from "../env";
import { workersAiEmbedder, type Embedder } from "./embed";

export interface VectorMetadata {
  /** Exact tool gate (≤ 64 bytes: string metadata indexes cover the first 64 bytes). */
  tool_name: string;
  /** "public" (approved) or "k:" + base64url(HMAC-SHA256(VISIBILITY_KEY, agent_key)) (pending, submitter only). */
  visibility: string;
  review_status: "pending_review" | "approved";
  embed_v: string;
}

export interface VectorRecord {
  /** The D1 lesson_id (UUID v4, 36 bytes; the limit is 64). */
  id: string;
  namespace: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorQueryOptions {
  namespace: string;
  topK: number;
  /**
   * Visibility gate, plus an exact tool gate for recall. The public search (src/routes/search.ts) leaves the tool
   * out on purpose. Compact JSON must stay under 2,048 bytes.
   */
  filter: { tool_name?: { $eq: string }; visibility: { $in: string[] } };
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity. */
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  query(values: number[], options: VectorQueryOptions): Promise<VectorMatch[]>;
}

/** Vectorize accepts 1,000 vectors per upsert from a Worker. Deletes are chunked the same way. */
export const MAX_UPSERT_BATCH = 1000;
export const MAX_DELETE_BATCH = 1000;

export function vectorizeStore(index: Vectorize): VectorStore {
  return {
    async upsert(records) {
      for (let i = 0; i < records.length; i += MAX_UPSERT_BATCH) {
        await index.upsert(
          records.slice(i, i + MAX_UPSERT_BATCH).map(({ id, namespace, values, metadata }) => ({ id, namespace, values, metadata: { ...metadata } })),
        );
      }
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += MAX_DELETE_BATCH) await index.deleteByIds(ids.slice(i, i + MAX_DELETE_BATCH));
    },
    async query(values, options) {
      const result = await index.query(values, {
        namespace: options.namespace,
        topK: options.topK,
        filter: options.filter,
        // High-precision scores: the similarity cutoff needs exact values, not approximations.
        returnValues: true,
        returnMetadata: "indexed",
      });
      return result.matches.map((match) => ({ id: match.id, score: match.score }));
    },
  };
}

export interface SearchDeps {
  embedder: Embedder;
  vectors: VectorStore;
}

/** Resolved per request, because the bindings only exist on `env`. Tests inject fakes here. */
export type SearchFactory = (env: Env) => SearchDeps;

export const defaultSearch: SearchFactory = (env) => ({
  embedder: workersAiEmbedder(env.AI),
  vectors: vectorizeStore(env.VECTORIZE_INDEX),
});
