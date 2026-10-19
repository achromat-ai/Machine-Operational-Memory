/**
 * Fake Workers AI and Vectorize. Both run only against the real Cloudflare account,
 * so tests inject these through createApp/createWorker `search`.
 *
 * FakeEmbedder is a hashed bag of words: identical texts score 1.0 and texts that share
 * most of their words score high, which is enough to exercise the cutoff deterministically.
 * MemoryVectorStore applies the same namespace, $eq and $in semantics Vectorize does.
 */
import type { Embedder } from "../../src/search/embed";
import { EMBEDDING_DIMENSIONS } from "../../src/search/intent";
import type { SearchDeps, SearchFactory, VectorMatch, VectorQueryOptions, VectorRecord, VectorStore } from "../../src/search/vectors";

function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Unit-length hashed bag of words over EMBEDDING_DIMENSIONS buckets. */
export function hashEmbed(text: string): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const bucket = fnv1a(word) % EMBEDDING_DIMENSIONS;
    values[bucket] = (values[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export class FakeEmbedder implements Embedder {
  /** Every embed() call, in order. */
  calls: string[][] = [];
  /** Makes embed() throw for the calls this returns true for. */
  fail: ((texts: string[]) => boolean) | null = null;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    if (this.fail?.(texts)) throw new Error("fake embedder failure");
    return texts.map(hashEmbed);
  }
}

export class MemoryVectorStore implements VectorStore {
  records = new Map<string, VectorRecord>();
  upsertCalls: VectorRecord[][] = [];
  deleteCalls: string[][] = [];
  queryCalls: Array<{ values: number[]; options: VectorQueryOptions }> = [];
  failUpsert = false;
  failQuery = false;
  /** Simulates a stale or buggy index that ignores the metadata filter (the D1 re-check must still hold). */
  ignoreFilter = false;
  /** Forces the score returned for an id (cutoff tests). */
  scoreOverride = new Map<string, number>();

  async upsert(records: VectorRecord[]): Promise<void> {
    if (this.failUpsert) throw new Error("fake vectorize upsert failure");
    this.upsertCalls.push(records.map((record) => ({ ...record })));
    for (const record of records) this.records.set(record.id, { ...record });
  }

  async deleteByIds(ids: string[]): Promise<void> {
    this.deleteCalls.push([...ids]);
    for (const id of ids) this.records.delete(id);
  }

  async query(values: number[], options: VectorQueryOptions): Promise<VectorMatch[]> {
    this.queryCalls.push({ values, options });
    if (this.failQuery) throw new Error("fake vectorize query failure");
    return [...this.records.values()]
      .filter(
        (record) =>
          record.namespace === options.namespace &&
          (this.ignoreFilter ||
            (record.metadata.tool_name === options.filter.tool_name.$eq &&
              options.filter.visibility.$in.includes(record.metadata.visibility))),
      )
      .map((record) => ({ id: record.id, score: this.scoreOverride.get(record.id) ?? cosine(values, record.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
  }
}

export function fakeSearch(): { search: SearchFactory; embedder: FakeEmbedder; store: MemoryVectorStore; deps: SearchDeps } {
  const embedder = new FakeEmbedder();
  const store = new MemoryVectorStore();
  const deps: SearchDeps = { embedder, vectors: store };
  return { search: () => deps, embedder, store, deps };
}
