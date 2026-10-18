import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { buildWebhookRequest, createNotifier, detectReset, ntfyMessage, redact, webhookFormat, type ResetEvent } from "./notify";
import type { UsagePoint } from "./adapters/types";

const EVENT: ResetEvent = {
  provider: "claude",
  window: "five_hour",
  resetAt: "2026-10-18T15:00:00.000Z",
  usedPercent: 0,
  detectedAt: "2026-10-18T15:00:05.000Z",
  dedupeKey: "claude|five_hour|reset|2026-10-18T15:00:00.000Z",
};

function point(overrides: Partial<UsagePoint>): UsagePoint {
  return {
    provider: "claude",
    kind: "quota",
    label: "claude-5h-percent",
    model: null,
    used: 40,
    limit: 100,
    remaining: 60,
    unit: "percent",
    window_start: null,
    window_end: null,
    reset_at: "2026-10-18T15:00:00.000Z",
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: "2026-10-18T12:00:00.000Z",
    quota_window: "five_hour",
    source: "usage-command",
    stale: false,
    used_percent: 40,
    ...overrides,
  };
}

describe("webhook format", () => {
  test("auto-detects ntfy.sh and honors an explicit override", () => {
    expect(webhookFormat({}, "https://ntfy.sh/some-topic")).toBe("ntfy");
    expect(webhookFormat({ MODELIZER_WEBHOOK_FORMAT: "json" }, "https://ntfy.sh/some-topic")).toBe("json");
    expect(webhookFormat({}, "https://example.test/hook")).toBe("json");
    expect(webhookFormat({ MODELIZER_WEBHOOK_FORMAT: "ntfy" }, "https://alerts.example.test/hook")).toBe("ntfy");
  });

  test("ntfy is plain text with Title and Tags; json is the notice object; both sign the body", () => {
    const ntfy = buildWebhookRequest({ url: "https://ntfy.sh/topic", format: "ntfy", secret: "s3cr3t", event: EVENT });
    expect(ntfy.body).toBe("Claude 5-hour window reset, 0% used");
    expect(ntfy.headers.Title).toBe("Modelizer: Claude credits reset");
    expect(ntfy.headers.Tags).toBe("white_check_mark");
    expect(ntfy.headers.Authorization).toBe("Bearer s3cr3t");
    expect(ntfy.headers["X-Modelizer-Signature"]).toBe(
      `sha256=${createHmac("sha256", "s3cr3t").update(ntfy.body).digest("hex")}`,
    );
    expect(ntfyMessage(EVENT).body).toBe(ntfy.body);

    const json = buildWebhookRequest({ url: "https://example.test/hook", format: "json", secret: "s3cr3t", event: EVENT });
    expect(JSON.parse(json.body)).toEqual({
      provider: "claude",
      window: "five_hour",
      resetAt: EVENT.resetAt,
      usedPercent: 0,
      detectedAt: EVENT.detectedAt,
    });
    expect(json.headers.Title).toBeUndefined();
    expect(json.headers["X-Modelizer-Signature"]).toBe(
      `sha256=${createHmac("sha256", "s3cr3t").update(json.body).digest("hex")}`,
    );
  });

  test("redact strips the secret and the topic path", () => {
    const url = "https://ntfy.sh/super-secret-topic";
    const text = redact(`failed ${url} token s3cr3t`, url, "s3cr3t");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("super-secret-topic");
  });
});

describe("detectReset", () => {
  const prev = {
    provider: "claude",
    window: "five_hour",
    usedPercent: 80,
    resetsAt: "2026-10-18T15:00:00.000Z",
    observedAt: "2026-10-18T12:00:00.000Z",
  };

  test("baseline is not a reset; a passed reset fires once with 0% until a fresh window arrives", () => {
    const now = new Date("2026-10-18T14:00:00.000Z");
    expect(detectReset(prev, { ...prev, resetsAt: prev.resetsAt, usedPercent: 80 }, now)).toBeNull();
    const passed = detectReset(prev, { provider: "claude", window: "five_hour", usedPercent: 80, resetsAt: prev.resetsAt }, new Date("2026-10-18T15:00:01.000Z"));
    expect(passed).toMatchObject({ usedPercent: 0, resetAt: prev.resetsAt });
    const fresh = detectReset(
      prev,
      { provider: "claude", window: "five_hour", usedPercent: 4, resetsAt: "2026-10-18T20:00:00.000Z" },
      new Date("2026-10-18T15:00:01.000Z"),
    );
    expect(fresh).toMatchObject({ usedPercent: 4, resetAt: prev.resetsAt });
  });

  test("a sharp drop before the scheduled reset is its own notice", () => {
    const now = new Date("2026-10-18T13:00:00.000Z");
    const drop = detectReset(prev, { provider: "codex", window: "weekly", usedPercent: 5, resetsAt: "2026-10-25T00:00:00.000Z" }, now);
    expect(drop?.usedPercent).toBe(5);
    expect(drop?.resetAt).toBe(now.toISOString());
    expect(drop?.dedupeKey).toContain("drop");
    const small = detectReset(prev, { provider: "claude", window: "five_hour", usedPercent: 60, resetsAt: prev.resetsAt }, now);
    expect(small).toBeNull();
  });
});

describe("notifier delivery", () => {
  test("unset URL is off", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-notify-")), "n.db"));
    expect(createNotifier({ db, env: {} })).toBeUndefined();
    db.close();
  });

  test("posts once when the reset passes, retries a 500, and does not log the secret", async () => {
    const hits: Array<{ body: string; title: string | null; tags: string | null; auth: string | null }> = [];
    const logs: string[] = [];
    let fail = true;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        hits.push({
          body: "",
          title: req.headers.get("title"),
          tags: req.headers.get("tags"),
          auth: req.headers.get("authorization"),
        });
        const last = hits[hits.length - 1];
        if (last) last.body = "";
        return req.text().then((body) => {
          const row = hits[hits.length - 1];
          if (row) row.body = body;
          if (fail) {
            fail = false;
            return new Response("nope", { status: 500 });
          }
          return new Response("ok", { status: 200 });
        });
      },
    });
    const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-notify-")), "n.db"));
    const secret = "s3cr3t-value";
    const topic = "phone-topic-name";
    const notifier = createNotifier({
      db,
      env: {
        MODELIZER_WEBHOOK_URL: `http://127.0.0.1:${server.port}/${topic}`,
        MODELIZER_WEBHOOK_SECRET: secret,
        MODELIZER_WEBHOOK_FORMAT: "ntfy",
      },
      sleep: async () => {},
      retryDelaysMs: [1],
      log: (m) => logs.push(m),
    });
    if (!notifier) throw new Error("notifier should be on");

    db.insertPoints([point({})]);
    await notifier.scan(new Date("2026-10-18T12:00:00.000Z")); // baseline
    expect(hits.length).toBe(0);

    await notifier.scan(new Date("2026-10-18T15:00:05.000Z"));
    expect(hits.length).toBe(2); // 500 then 200
    expect(hits[1]?.body).toBe("Claude 5-hour window reset, 0% used");
    expect(hits[1]?.title).toBe("Modelizer: Claude credits reset");
    expect(hits[1]?.tags).toBe("white_check_mark");
    expect(hits[1]?.auth).toBe(`Bearer ${secret}`);

    await notifier.scan(new Date("2026-10-18T15:01:00.000Z"));
    expect(hits.length).toBe(2);

    const joined = logs.join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain(topic);
    expect(joined).toContain("delivered claude five_hour");

    server.stop(true);
    db.close();
  });

  test("a sharp drop posts the new percent and does not repeat", async () => {
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.text());
        return new Response("ok");
      },
    });
    const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-notify-")), "n.db"));
    const notifier = createNotifier({
      db,
      env: { MODELIZER_WEBHOOK_URL: `http://127.0.0.1:${server.port}/hook` },
      sleep: async () => {},
      retryDelaysMs: [],
      log: () => {},
    });
    if (!notifier) throw new Error("notifier");
    db.insertPoints([point({ provider: "codex", label: "codex-weekly-percent", quota_window: "weekly", used: 70, used_percent: 70, reset_at: "2026-10-25T00:00:00.000Z" })]);
    await notifier.scan(new Date("2026-10-18T12:00:00.000Z"));
    db.insertPoints([point({
      provider: "codex",
      label: "codex-weekly-percent",
      quota_window: "weekly",
      used: 3,
      used_percent: 3,
      remaining: 97,
      reset_at: "2026-10-25T06:00:00.000Z",
      captured_at: "2026-10-18T13:00:00.000Z",
    })]);
    await notifier.scan(new Date("2026-10-18T13:00:00.000Z"));
    await notifier.scan(new Date("2026-10-18T13:05:00.000Z"));
    expect(bodies.length).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ provider: "codex", window: "weekly", usedPercent: 3 });
    server.stop(true);
    db.close();
  });
});
