import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { RawPoll } from "./adapters/types";

/**
 * Integration test: the collect worker runs an adapter on its own thread and posts the raw polls
 * back. Moonshot against a local fixture server keeps the network out of it.
 */

const app = new Hono().get("/v1/users/me/balance", (c) =>
  c.json({ code: 0, data: { available_balance: "7", voucher_balance: "0", total_granted: "9", total_used: "2" } }),
);
const server = Bun.serve({ port: 4789, fetch: app.fetch });
afterAll(() => server.stop(true));

const worker = new Worker(new URL("./collect-worker.ts", import.meta.url), { type: "module" });
afterAll(() => worker.terminate());

/** One job; resolves with the reply that completes it. Logs surface through onLog. */
function job(
  payload: { adapterId: string; env?: Record<string, string | undefined>; at?: string },
  onLog?: (msg: string) => void,
): Promise<{ polls?: RawPoll[]; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    const timer = setTimeout(() => reject(new Error("worker job timed out")), 15_000);
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { id: number; log?: string; polls?: RawPoll[]; error?: string };
      if (msg.id !== id) return;
      if (msg.log !== undefined) {
        onLog?.(msg.log);
        return;
      }
      clearTimeout(timer);
      const reply: { polls?: RawPoll[]; error?: string } = {};
      if (msg.polls !== undefined) reply.polls = msg.polls;
      if (msg.error !== undefined) reply.error = msg.error;
      resolve(reply);
    };
    worker.postMessage({ id, adapterId: payload.adapterId, env: payload.env ?? {}, at: payload.at ?? "2026-10-31T00:00:00Z" });
  });
}

describe("collect worker", () => {
  test("runs an isolated adapter off-thread and returns its raw polls", async () => {
    const reply = await job({
      adapterId: "moonshot",
      env: { MOONSHOT_API_KEY: "sk-test", MOONSHOT_BASE_URL: "http://127.0.0.1:4789" },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.polls).toHaveLength(1);
    expect(reply.polls?.[0]?.status).toBe(200);
    expect(reply.polls?.[0]?.endpoint).toBe("balance");
  });

  test("an unknown adapter id comes back as an error, not a hang", async () => {
    const reply = await job({ adapterId: "nonexistent" });
    expect(reply.error).toContain("unknown adapter");
  });
});
