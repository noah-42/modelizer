import { describe, expect, test } from "bun:test";
import { parseResetMention, parseUsageText, recordFromHookPayload, zonedTimeToUtc } from "./usage-text";

const NOW = new Date("2026-10-18T12:00:00.000Z");

describe("parseUsageText", () => {
  test("sectioned prose: session and weekly, scoped week loses to all-models", () => {
    const text = [
      "Current session",
      "62% used",
      "Resets in 3h 12m",
      "",
      "Current week (all models)",
      "11% used",
      "Resets in 4d 2h",
      "",
      "Current week (Sonnet only)",
      "4% used",
      "Resets in 4d 2h",
    ].join("\n");
    const { windows } = parseUsageText(text, NOW);
    const five = windows.find((w) => w.window === "five_hour");
    const week = windows.find((w) => w.window === "weekly");
    expect(five).toEqual({ window: "five_hour", usedPercent: 62, resetsAt: "2026-10-18T15:12:00.000Z" });
    expect(week).toEqual({ window: "weekly", usedPercent: 11, resetsAt: "2026-10-22T14:00:00.000Z" });
  });

  test("one-line prose and JSON both yield ISO resets", () => {
    const prose = parseUsageText(
      "Session: 19% used · resets 2026-10-06T23:00:00.000Z\nWeekly: 3% used · resets 2026-10-12T00:00:00.000Z\n",
      NOW,
    );
    expect(prose.windows.map((w) => [w.window, w.usedPercent, w.resetsAt])).toEqual([
      ["five_hour", 19, "2026-10-06T23:00:00.000Z"],
      ["weekly", 3, "2026-10-12T00:00:00.000Z"],
    ]);

    const json = parseUsageText(JSON.stringify({
      five_hour: { utilization: 40, resets_at: "2026-10-18T20:00:00Z" },
      seven_day: { utilization: 8, resets_at: "2026-10-20T00:00:00Z" },
    }), NOW);
    expect(json.windows).toEqual([
      { window: "five_hour", usedPercent: 40, resetsAt: "2026-10-18T20:00:00.000Z" },
      { window: "weekly", usedPercent: 8, resetsAt: "2026-10-20T00:00:00.000Z" },
    ]);
  });

  test("garbage and empty input yield no windows", () => {
    expect(parseUsageText("hello, this is not a usage report", NOW).windows).toEqual([]);
    expect(parseUsageText("   ", NOW).windows).toEqual([]);
    expect(parseUsageText("{not json", NOW).windows).toEqual([]);
  });

  test("weekday clock in Europe/Berlin", () => {
    // 2026-10-18 is a Sunday; next Wednesday 02:40 is still CEST (UTC+2).
    const mention = parseResetMention("You've hit your session limit · resets Wed 02:40 (Europe/Berlin)", NOW);
    expect(mention.window).toBe("five_hour");
    expect(mention.resetsAt).toBe("2026-10-21T00:40:00.000Z");
    expect(zonedTimeToUtc(2026, 10, 21, 2, 40, "Europe/Berlin").toISOString()).toBe("2026-10-21T00:40:00.000Z");
  });
});

describe("recordFromHookPayload", () => {
  test("rate_limit message with a relative reset", () => {
    const rec = recordFromHookPayload({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "API Error: Rate limit reached. Resets in 2h 5m",
    }, NOW);
    expect(rec?.error).toBe("rate_limit");
    expect(rec?.window).toBeNull();
    expect(rec?.resetsAt).toBe("2026-10-18T14:05:00.000Z");
  });

  test("weekly phrase and explicit resets_at win; other errors are ignored", () => {
    const rec = recordFromHookPayload({
      error: "rate_limit",
      message: "weekly limit reached",
      error_details: { resets_at: "2026-10-20T18:00:00Z", window: "weekly" },
    }, NOW);
    expect(rec?.window).toBe("weekly");
    expect(rec?.resetsAt).toBe("2026-10-20T18:00:00.000Z");
    expect(recordFromHookPayload({ error: "overloaded", message: "nope" }, NOW)).toBeNull();
    expect(recordFromHookPayload(null, NOW)).toBeNull();
  });
});
