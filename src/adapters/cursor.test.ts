import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  cursorAdapter,
  cursorFactsFromProfile,
  cursorStatePath,
  cursorPeriodPoint,
  readCursorAccessToken,
  cursorTokenIsEncrypted,
  decryptCursorToken,
  readCursorSafeStoragePassword,
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

/** The weekly period this plan meters on, as Cursor sends it: epoch milliseconds in strings. */
const period = {
  billingCycleStart: "1792245679604",
  billingCycleEnd: "1792850479604",
  planUsage: { autoPercentUsed: 90.27, apiPercentUsed: 0, totalPercentUsed: 90.27 },
  enabled: true,
  displayMessage: "You've used 90% of your included usage",
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

/** Re-implements the app-side wrap so decrypt tests do not need real Cursor state. */
function encryptLikeCursor(token: string, safeStoragePassword: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const key = crypto.pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const blob = Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(Buffer.from(token, "utf8")), cipher.final()]);
  return `cursor-safe-storage:v1:${blob.toString("base64")}`;
}

describe("decryptCursorToken", () => {
  const password = "cursor-safe-storage-test-password";

  test("round-trips the Chromium os_crypt envelope", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.part.three-of-a-jwt-bearer";
    expect(decryptCursorToken(encryptLikeCursor(token, password), password)).toBe(token);
  });

  test("rejects a wrong password instead of returning garbage", () => {
    const envelope = encryptLikeCursor("eyJhbGciOiJIUzI1NiJ9.part.three", password);
    expect(decryptCursorToken(envelope, "different-password")).toBeNull();
  });

  test("rejects values that are not a v1 envelope", () => {
    expect(decryptCursorToken("cursor-safe-storage:AAABBB", password)).toBeNull();
    expect(decryptCursorToken("plaintext-bearer", password)).toBeNull();
    expect(decryptCursorToken("cursor-safe-storage:v1:!!!!not-base64!!!!", password)).toBeNull();
  });

  test("rejects a blob whose plaintext does not look like a token", () => {
    // Valid CBC padding but decrypts to a short control-character string.
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const blob = Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(Buffer.from("\u0001\u0002", "utf8")), cipher.final()]);
    expect(decryptCursorToken(`cursor-safe-storage:v1:${blob.toString("base64")}`, password)).toBeNull();
  });

  test("reads the safe-storage password through the injected runner", () => {
    expect(readCursorSafeStoragePassword(() => ({ status: 0, stdout: "pw\n" }))).toBe("pw");
    expect(readCursorSafeStoragePassword(() => ({ status: 44, stdout: "" }))).toBeNull();
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

  test("treats the cursor-safe-storage envelope as unreadable, not as a bearer", () => {
    const path = join(root, "encrypted.vscdb");
    const db = new Database(path);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      "cursor-safe-storage:AAABBB",
    );
    db.close();
    expect(readCursorAccessToken(path)).toBeNull();
    expect(cursorTokenIsEncrypted(path)).toBe(true);
  });
});

describe("cursorAdapter", () => {
  test("CURSOR_STATE_DB overrides the default path", () => {
    expect(cursorStatePath({ CURSOR_STATE_DB: "/tmp/custom.vscdb" })).toBe("/tmp/custom.vscdb");
    expect(cursorStatePath({})).toContain("Cursor/User/globalStorage/state.vscdb");
  });

  test("reports the weekly period as a percent quota window", () => {
    const points = cursorAdapter.normalize([poll(period, 200, "period-usage")], NOW.toISOString());
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      provider: "cursor",
      label: "cursor-included-usage",
      kind: "quota",
      used: 90.27,
      limit: 100,
      unit: "percent",
      quota_window: "weekly",
      window_start: new Date(1792245679604).toISOString(),
      reset_at: new Date(1792850479604).toISOString(),
      source: "cursor-api",
    });
  });

  test("401/403 from Cursor is an auth failure naming the sign-in fix", () => {
    const reason = cursorAdapter.authFailure?.([poll(period, 401, "period-usage")]);
    expect(reason).toContain("rejected the stored access token");
    expect(reason).toContain("Sign out and back in");
    expect(cursorAdapter.authFailure?.([poll(profile, 403, "stripe-profile")])).toContain("HTTP 403");
    expect(cursorAdapter.authFailure?.([poll(profile, 200, "stripe-profile")])).toBeNull();
    expect(cursorAdapter.authFailure?.([poll(period, 200, "period-usage")])).toBeNull();
  });

  test("leaves room in the period rather than a negative remainder", () => {
    expect(cursorPeriodPoint({ ...period, planUsage: { totalPercentUsed: 90 } }, NOW.toISOString())).toMatchObject({
      remaining: 10,
    });
    expect(cursorPeriodPoint({ ...period, planUsage: { totalPercentUsed: 120 } }, NOW.toISOString())).toMatchObject({
      remaining: 0,
    });
  });

  test("names a monthly period when the plan meters monthly", () => {
    const monthly = {
      ...period,
      billingCycleEnd: String(1792245679604 + 30 * 86_400_000),
    };
    expect(cursorPeriodPoint(monthly, NOW.toISOString())).toMatchObject({ quota_window: "monthly" });
  });

  test("reports no usage points when the period poll fails", () => {
    expect(cursorAdapter.normalize([poll(profile)], NOW.toISOString())).toEqual([]);
    expect(cursorAdapter.normalize([poll({ message: "nope" }, 401, "period-usage")], NOW.toISOString())).toEqual([]);
  });

  test("reports nothing rather than a blank window when the response carries no period", () => {
    expect(cursorPeriodPoint({}, NOW.toISOString())).toBeNull();
    expect(cursorPeriodPoint({ planUsage: { totalPercentUsed: 20 } }, NOW.toISOString())).toBeNull();
  });

  test("reports facts from a successful profile poll", () => {
    expect(cursorAdapter.subscriptionFacts?.([poll(profile)], NOW)).toMatchObject({ planId: "pro", state: "active" });
    expect(cursorAdapter.subscriptionFacts?.([poll(profile, 401)], NOW)).toBeNull();
  });
});

// Cleanup last so the database handles above are closed.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
