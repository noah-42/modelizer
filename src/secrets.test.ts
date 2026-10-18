import { describe, expect, test } from "bun:test";
import { resolveEnv } from "./secrets";

describe("resolveEnv (keychain)", () => {
  test("env wins over keychain", () => {
    const env = resolveEnv(
      { ZAI_API_KEY: "from-env" },
      {
        platform: "darwin",
        run: () => ({ status: 0, stdout: "from-keychain\n" }),
      },
    );
    expect(env.ZAI_API_KEY).toBe("from-env");
  });

  test("missing env var filled from keychain, others untouched", () => {
    const env = resolveEnv(
      { OPENROUTER_API_KEY: "or", MODELIZER_DB: "x.db" },
      {
        platform: "darwin",
        run: (args) => {
          const account = args[4];
          return account === "ZAI_API_KEY" ? { status: 0, stdout: "secret\n" } : { status: 44, stdout: "" };
        },
      },
    );
    expect(env.ZAI_API_KEY).toBe("secret");
    expect(env.OPENROUTER_API_KEY).toBe("or");
    expect(env.MODELIZER_DB).toBe("x.db");
    expect(env.MOONSHOT_API_KEY).toBeUndefined();
  });

  test("non-darwin skips the keychain entirely", () => {
    let called = false;
    const env = resolveEnv(
      {},
      {
        platform: "linux",
        run: () => {
          called = true;
          return { status: 0, stdout: "nope" };
        },
      },
    );
    expect(called).toBe(false);
    expect(env.ZAI_API_KEY).toBeUndefined();
  });

  test("keychain failure (not found) stays silent", () => {
    const env = resolveEnv({}, { platform: "darwin", run: () => ({ status: 44, stdout: "" }) });
    expect(env.ZAI_API_KEY).toBeUndefined();
  });
});
