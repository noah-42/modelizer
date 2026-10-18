import { describe, expect, test } from "bun:test";
import { exchangeRateLimits, spawnAppServer, type RpcIo } from "./codex-app-server";
import { parseAppServerRateLimits } from "./codex-limits";

describe("codex app-server handshake", () => {
  test("initialize, initialized, account/rateLimits/read — no model turn", async () => {
    const sent: Array<{ method?: string; id?: number }> = [];
    const scripted: unknown[] = [
      { id: 1, result: { userAgent: "codex" } },
      { method: "account/rateLimits/updated", params: {} },
      {
        id: 2,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791910105 },
            secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1792000000 },
          },
          rateLimitResetCredits: { availableCount: 2, credits: [{ id: "c1" }] },
        },
      },
    ];
    let i = 0;
    const io: RpcIo = {
      send(msg) { sent.push(msg as { method?: string; id?: number }); },
      next() { return Promise.resolve(scripted[i++] ?? null); },
      close() {},
    };
    const result = await exchangeRateLimits(io, 1_000);
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(JSON.stringify(sent)).not.toContain("turn/start");
    expect(JSON.stringify(sent)).not.toContain("thread/start");

    const limits = parseAppServerRateLimits(result, "2026-10-18T12:00:00.000Z");
    expect(limits?.byWindow.five_hour).toMatchObject({
      usedPercent: 25,
      windowMinutes: 300,
      source: "app-server",
      resetsAt: new Date(1791910105 * 1000).toISOString(),
    });
    expect(limits?.byWindow.weekly?.usedPercent).toBe(4);
  });

  test("duration classifies a swapped primary; a 15-minute toy window is not a 5h window", () => {
    const swapped = parseAppServerRateLimits({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792000000 },
          secondary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1791910105 },
        },
      },
    }, "2026-10-18T12:00:00.000Z");
    expect(swapped?.byWindow.five_hour?.usedPercent).toBe(70);
    expect(swapped?.byWindow.weekly?.usedPercent).toBe(3);

    const toy = parseAppServerRateLimits({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 15, resetsAt: 1730947200 }, secondary: null },
    }, "2026-10-18T12:00:00.000Z");
    expect(toy?.byWindow.five_hour).toBeUndefined();
    expect(toy?.byWindow.weekly).toBeUndefined();
  });

  test("a missing binary is reported without throwing", async () => {
    const result = await spawnAppServer("modelizer-codex-missing", ["app-server"], 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toBe(true);
  });
});
