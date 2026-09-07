import type { QueryExecutor } from './executor.js';

/**
 * Doc-source seam (BI connectors plan, decision 10): every BI platform connector consumes
 * typed docs through this one interface regardless of how they were acquired — a live API
 * pull (`ApiDocSource`) or an uploaded/parsed file (`FileDocSource`). The connector's
 * `extract()` and its mapper (`mapXDocs(docs, mode)`) never need to know which one fed them,
 * so live and file modes converge on one mapper (spec §4 one-normalizer invariant).
 */
export interface BiDocSource<TDoc> {
  docs(): AsyncGenerator<TDoc>;
}

/**
 * Issue one BI API call and receive the unwrapped JSON response. The request is
 * serialized as the executor's statement text; `stepId` is the call's stable replay
 * identity (decision 10: 'signin', 'workbooks:<page>', 'workspaces_list', 'scan:<n>',
 * 'lakeview_list', 'lakeview_get:<id>', ...).
 */
export type BiApiFetch = (request: unknown, stepId: string) => Promise<unknown>;

/**
 * Live mode: wraps a `QueryExecutor` whose `execute(requestJson, stepId)` returns
 * `[{json: <response>}]` rows (decision 10) — live transports and `ReplayExecutor`
 * fixtures are interchangeable behind it. Step sequencing/pagination is platform-specific
 * (Tasks 5/7 own it), so the constructor takes a `strategy`: a generator that issues
 * requests through the provided `fetch` — which drives the executor and unwraps the
 * `json` payload — and turns the responses into typed docs.
 */
export class ApiDocSource<TDoc> implements BiDocSource<TDoc> {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly strategy: (fetch: BiApiFetch) => AsyncGenerator<TDoc>,
  ) {}

  docs(): AsyncGenerator<TDoc> {
    const { executor } = this;
    const fetch: BiApiFetch = async (request, stepId) => {
      const requestJson = typeof request === 'string' ? request : JSON.stringify(request);
      const rows = await executor.execute(requestJson, stepId);
      const payload = rows[0]?.json;
      if (payload === undefined) {
        throw new Error(
          `BI API step '${stepId}' returned no {json: ...} row — transports and replay ` +
            `fixtures must wrap every response as [{json: <response>}] (plan decision 10)`,
        );
      }
      // Text-recorded fixture rows may carry the response as a JSON string.
      return typeof payload === 'string' ? JSON.parse(payload) : payload;
    };
    return this.strategy(fetch);
  }
}

/**
 * File mode: wraps an already-parsed array of docs (from an uploaded file) as the same
 * async-generator seam a live pull would produce.
 */
export class FileDocSource<TDoc> implements BiDocSource<TDoc> {
  constructor(private readonly items: readonly TDoc[]) {}

  async *docs(): AsyncGenerator<TDoc> {
    for (const item of this.items) yield item;
  }
}
