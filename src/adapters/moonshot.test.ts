import { describe, expect, test } from "bun:test";
import { moonshotAdapter } from "./moonshot";
import { NormalizeError } from "./types";
import type { RawPoll } from "./types";

// Shape from the documented account-balance endpoint, amounts arrive as strings.
const BALANCE_OK = {
  code: 0,
  data: {
    available_balance: "10.5",
    voucher_balance: "2.25",
    total_granted: "15",
    total_used: "4.5",
    status: "normal",
  },
};

const BALANCE_NUMBERS = {
  code: 0,
  data: {
    available_balance: 10.5,
    voucher_balance: 0,
    total_granted: 15,
    total_used: 4.5,
  },
};

function poll(url: string, json: unknown, status = 200): RawPoll {
  return { endpoint: "balance", url, status, body: JSON.stringify(json), json, headers: {} };
}

const AT = "2026-10-30T01:00:00Z";
const AI_URL = "https://api.moonshot.ai/v1/users/me/balance";
const CN_URL = "https://api.moonshot.cn/v1/users/me/balance";

describe("moonshot adapter", () => {
  test("isConfigured follows the key, missingCredentials names it", () => {
    expect(moonshotAdapter.isConfigured({})).toBe(false);
    expect(moonshotAdapter.isConfigured({ MOONSHOT_API_KEY: "sk-x" })).toBe(true);
    expect(moonshotAdapter.missingCredentials({})).toEqual(["MOONSHOT_API_KEY"]);
    expect(moonshotAdapter.missingCredentials({ MOONSHOT_API_KEY: "sk-x" })).toEqual([]);
  });

  test("collect GETs the balance endpoint with the key as a bearer header", async () => {
    const urls: string[] = [];
    const headers: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify(BALANCE_OK), { status: 200 });
    }) as typeof fetch;
    const polls = await moonshotAdapter.collect({
      fetchFn,
      env: { MOONSHOT_API_KEY: "sk-x" },
      now: new Date(AT),
      log: () => {},
    });
    expect(urls).toEqual(["https://api.moonshot.ai/v1/users/me/balance"]);
    expect(headers).toEqual(["Bearer sk-x"]);
    expect(polls).toHaveLength(1);
    expect(polls[0]?.endpoint).toBe("balance");
  });

  test("collect honors MOONSHOT_BASE_URL", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(BALANCE_OK), { status: 200 });
    }) as typeof fetch;
    await moonshotAdapter.collect({
      fetchFn,
      env: { MOONSHOT_API_KEY: "sk-x", MOONSHOT_BASE_URL: "https://api.moonshot.cn/" },
      now: new Date(AT),
      log: () => {},
    });
    expect(urls).toEqual(["https://api.moonshot.cn/v1/users/me/balance"]);
  });

  test("balance reads the documented fields; currency follows the host", () => {
    const points = moonshotAdapter.normalize([poll(AI_URL, BALANCE_OK)], AT);
    const balance = points.find((p) => p.label === "balance");
    expect(balance?.kind).toBe("balance");
    expect(balance?.used).toBe(4.5);
    expect(balance?.limit).toBe(15);
    expect(balance?.remaining).toBe(10.5);
    expect(balance?.unit).toBe("usd");
    const voucher = points.find((p) => p.label === "voucher-credit");
    expect(voucher?.remaining).toBe(2.25);
    expect(voucher?.unit).toBe("usd");
  });

  test("the .cn host is tracked in CNY", () => {
    const points = moonshotAdapter.normalize([poll(CN_URL, BALANCE_NUMBERS)], AT);
    expect(points.every((p) => p.unit === "cny")).toBe(true);
  });

  test("numeric and string amounts both normalize", () => {
    const a = moonshotAdapter.normalize([poll(AI_URL, BALANCE_OK)], AT);
    const b = moonshotAdapter.normalize([poll(AI_URL, BALANCE_NUMBERS)], AT);
    expect(a.find((p) => p.label === "balance")?.remaining).toBe(b.find((p) => p.label === "balance")?.remaining);
  });

  test("a non-zero code is a loud normalize error, not a silent zero", () => {
    expect(() => moonshotAdapter.normalize([poll(AI_URL, { code: 40101, message: "quota exceeded" })], AT)).toThrow(
      NormalizeError,
    );
  });

  test("an unexpected shape is loud", () => {
    expect(() => moonshotAdapter.normalize([poll(AI_URL, { error: { message: "nope" } })], AT)).toThrow(NormalizeError);
    expect(() => moonshotAdapter.normalize([], AT)).toThrow(NormalizeError);
  });
});
