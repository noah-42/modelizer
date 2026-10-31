import { describe, expect, test } from "bun:test";
import { formatProblem, validateSecretValue } from "./key-validation";

describe("formatProblem", () => {
  test("rejects the MOD004 failure modes without any network call", () => {
    expect(formatProblem("<6d98fe608dc>")).toContain("< or >");
    expect(formatProblem("abc def")).toContain("whitespace");
    expect(formatProblem("")).toContain("empty");
  });
  test("a bare key passes the format gate", () => {
    expect(formatProblem("6d98fe608dc1")).toBeNull();
  });
});

describe("validateSecretValue", () => {
  const env = { ZAI_BASE_URL: "http://127.0.0.1:9999" };

  test("ZAI_API_KEY must answer 200 — a rejection names the provider and code", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 })) as unknown as typeof fetch;
    // body 200 with auth-reject JSON is still HTTP 200: the HTTP gate passes (the poll
    // itself surfaces code-1000 as an auth failure) — format gate is the first line.
    expect(await validateSecretValue("ZAI_API_KEY", "goodkey", { env, fetchFn })).toBeNull();
  });

  test("an HTTP 401 from the provider is rejected before storage", async () => {
    const fetchFn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const reason = await validateSecretValue("ZAI_API_KEY", "deadkey", { env, fetchFn });
    expect(reason).toContain("z.ai");
    expect(reason).toContain("401");
  });

  test("network failure does not block a possibly-good key", async () => {
    const fetchFn = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    expect(await validateSecretValue("ZAI_API_KEY", "key", { env, fetchFn })).toBeNull();
  });

  test("credentials without a validator store as-is", async () => {
    expect(await validateSecretValue("MOONSHOT_API_KEY", "anything", { env })).toBeNull();
  });
});
