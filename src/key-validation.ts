/**
 * MOD005: write-time credential validation. A key is checked against its provider
 * BEFORE it is stored — by `scripts/set-key.sh` (terminal path) and by the manage
 * tab (web path). A malformed or dead key must fail loudly at the moment of entry,
 * never sit in the keychain producing 15 hours of opaque poll failures.
 *
 * Returns a reason string on rejection, null on acceptance. Never logs or returns
 * the value itself.
 */

export interface ValidateContext {
  env: Record<string, string | undefined>;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch | undefined;
}

const TIMEOUT_MS = 15_000;

/** Shape/format problems that are provider-independent and fail without any network call. */
export function formatProblem(value: string): string | null {
  if (value.length === 0) return "value is empty";
  if (/[<>]/.test(value)) return "value contains < or > — paste the bare key only, without placeholder brackets";
  if (/\s/.test(value)) return "value contains whitespace — paste the bare key only, on one line";
  return null;
}

export async function validateSecretValue(
  name: string,
  value: string,
  ctx: ValidateContext,
): Promise<string | null> {
  const format = formatProblem(value);
  if (format) return format;

  const fetchFn = ctx.fetchFn ?? fetch;
  // Mirrors the adapter base-url overrides, so tests and self-hosted proxies work.
  const targets: Record<string, { url: string; want: number; label: string }> = {
    ZAI_API_KEY: {
      url: `${(ctx.env.ZAI_BASE_URL ?? "https://api.z.ai").replace(/\/$/, "")}/api/monitor/usage/quota/limit`,
      want: 200,
      label: "z.ai",
    },
    OPENROUTER_API_KEY: { url: "https://openrouter.ai/api/v1/key", want: 200, label: "openrouter" },
  };
  const target = targets[name];
  if (!target) return null; // no validator for this credential — store as-is

  let status = 0;
  try {
    const res = await fetchFn(target.url, {
      headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
  } catch {
    // Network trouble must not block a possibly-good key — say so instead of failing it.
    return null;
  }
  if (status !== target.want) {
    return `rejected by ${target.label} (HTTP ${status}, expected ${target.want}) — check the key and try again`;
  }
  return null;
}
