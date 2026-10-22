import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  cursorAdapter,
  cursorFactsFromProfile,
  cursorStatePath,
  cursorUsagePoint,
  readCursorAccessToken,
} from "./cursor";
import type { RawPoll } from "./types";

const root = mkdtempSync(join(tmpdir(), "modelizer-cursor-"));
const NOW = new Date("2026-10-22T00:00:00.000Z");

const profile = {
  membershipType: "pro",
  subscriptionStatus: "active",
  isYearlyPlan: false,
  isTeamMember: false,
  trialEligible: true,
  pendingCancellationDate: null,
};

const usage = {
  billingCycleStart: "2026-10-01T00:00:00.000Z",
  billingCycleEnd: "2026-11-01T00:00:00.000Z",
  membershipType: "premium",
  isUnlimited: false,
  individualUsage: {
    plan: { enabled: true, used: 461, limit: 4615, remaining: 4154, totalPercentUsed: 10 },
    onDemand: { enabled: false, used: 0, limit: null, remaining: null },
  },
};

function poll(json: unknown, status = 200, endpoint = "stripe-profile"): RawPoll {
  return { endpoint, url: `https://api2.cursor.sh/auth/${endpoint}`, status, body: "", json, headers: {} };
}

describe("cursorFactsFromProfile", () => {
  test("reports the plan, billing state and period Cursor states", () => {
    expect(cursorFactsFromProfile(profile)).toEqual({
      provider: "cursor",
      planId: "pro",
      planName: "Cursor Pro",
      state: "active",
      period: "monthly",
      renewsAt: null,
      seats: 1,
      source: "cursor-api",
    });
  });

  test("marks a yearly plan as annual", () => {
    expect(cursorFactsFromProfile({ ...profile, isYearlyPlan: true })).toMatchObject({ period: "annual" });
  });

  test("returns null for a free account with no active plan", () => {
    expect(cursorFactsFromProfile({ membershipType: "free", subscriptionStatus: "canceled" })).toBeNull();
    expect(cursorFactsFromProfile({})).toBeNull();
  });

  test("keeps a cancelled paid plan visible so the page can show it", () => {
    expect(cursorFactsFromProfile({ ...profile, subscriptionStatus: "canceled" })).toMatchObject({
      planId: "pro",
      state: "cancelled",
    });
  });

  test("keeps an unknown plan id without inventing a label", () => {
    expect(cursorFactsFromProfile({ ...profile, membershipType: "ultra_plus" })).toMatchObject({
      planId: "ultra_plus",
      planName: null,
    });
  });
});

describe("readCursorAccessToken", () => {
  test("returns null when Cursor's state database does not exist", () => {
    expect(readCursorAccessToken(join(root, "absent.vscdb"))).toBeNull();
  });

  test("reads the token and ignores an empty value", () => {
    const path = join(root, "state.vscdb");
    const db = new Database(path);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", "tok-123");
    db.close();
    expect(readCursorAccessToken(path)).toBe("tok-123");

    const empty = join(root, "empty.vscdb");
    const db2 = new Database(empty);
    db2.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db2.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", "   ");
    db2.close();
    expect(readCursorAccessToken(empty)).toBeNull();
  });
});

describe("cursorAdapter", () => {
  test("CURSOR_STATE_DB overrides the default path", () => {
    expect(cursorStatePath({ CURSOR_STATE_DB: "/tmp/custom.vscdb" })).toBe("/tmp/custom.vscdb");
    expect(cursorStatePath({})).toContain("Cursor/User/globalStorage/state.vscdb");
  });

  test("reports the billing cycle as a percent quota window", () => {
    const points = cursorAdapter.normalize([poll(usage, 200, "usage-summary")], NOW.toISOString());
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      provider: "cursor",
      label: "cursor-plan-usage",
      kind: "quota",
      used: 10,
      limit: 100,
      remaining: 90,
      unit: "percent",
      quota_window: "monthly",
      window_start: "2026-10-01T00:00:00.000Z",
      reset_at: "2026-11-01T00:00:00.000Z",
      source: "cursor-api",
    });
  });

  test("names a yearly cycle as annual", () => {
    const yearly = { ...usage, billingCycleEnd: "2027-10-01T00:00:00.000Z" };
    expect(cursorUsagePoint(yearly, NOW.toISOString())).toMatchObject({ quota_window: "annual" });
  });

  test("reports no usage points when the usage poll fails", () => {
    expect(cursorAdapter.normalize([poll(profile)], NOW.toISOString())).toEqual([]);
    expect(cursorAdapter.normalize([poll({ message: "nope" }, 401, "usage-summary")], NOW.toISOString())).toEqual([]);
  });

  test("reports nothing rather than a blank window when the response has no cycle", () => {
    expect(cursorUsagePoint({}, NOW.toISOString())).toBeNull();
    expect(cursorUsagePoint({ individualUsage: {} }, NOW.toISOString())).toBeNull();
  });

  test("reports facts from a successful profile poll", () => {
    expect(cursorAdapter.subscriptionFacts?.([poll(profile)], NOW)).toMatchObject({ planId: "pro", state: "active" });
    expect(cursorAdapter.subscriptionFacts?.([poll(profile, 401)], NOW)).toBeNull();
  });
});

// Cleanup last so the database handles above are closed.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
