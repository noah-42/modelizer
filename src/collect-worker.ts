/**
 * Worker entry for isolated adapter collects. The scheduler posts a job; this thread runs the
 * adapter's collect (which may synchronously scan hundreds of megabytes of transcripts) and posts
 * the raw polls back, leaving the main thread's event loop free to serve requests.
 *
 * Messages in:  { id, adapterId, env, at }
 * Messages out: { id, log }  ·  { id, polls }  ·  { id, error }
 */
import { ADAPTERS_BY_ID } from "./adapters";
import type { RawPoll } from "./adapters/types";

interface Job {
  id: number;
  adapterId: string;
  env: Record<string, string | undefined>;
  at: string;
}

type Reply =
  | { id: number; log: string }
  | { id: number; polls: RawPoll[] }
  | { id: number; error: string };

const worker = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<Job>) => void) | null;
  postMessage: (message: Reply) => void;
};

worker.onmessage = async (ev: MessageEvent<Job>) => {
  const { id, adapterId, env, at } = ev.data;
  const adapter = ADAPTERS_BY_ID.get(adapterId);
  if (!adapter) {
    worker.postMessage({ id, error: `unknown adapter: ${adapterId}` });
    return;
  }
  try {
    const polls = await adapter.collect({
      fetchFn: fetch,
      env,
      now: new Date(at),
      log: (msg: string) => worker.postMessage({ id, log: msg }),
    });
    worker.postMessage({ id, polls });
  } catch (err) {
    worker.postMessage({ id, error: (err as Error).message });
  }
};
