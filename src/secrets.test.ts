import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, credentialStatus, removeSecret, resolveEnv, writeSecret } from "./secrets";

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

describe("keychain isolation (MODELIZER_KEYCHAIN_FILE)", () => {
  test("writes go to the isolated keychain file, never the login keychain", () => {
    const file = join(tmpdir(), `modelizer-test-${Date.now()}.keychain`);
    try {
      execSync(`security create-keychain -p modelizer-test "${file}"`);
      process.env.MODELIZER_KEYCHAIN_FILE = file;
      // absent before the write, in both stores
      const env = resolveEnv({});
      expect(credentialStatus(env, "ZAI_API_KEY").source).toBe("absent");
      writeSecret("ZAI_API_KEY", "test-value-123");
      // found in the isolated file
      const after = resolveEnv({});
      expect(credentialStatus(after, "ZAI_API_KEY")).toMatchObject({ set: true, source: "keychain" });
      // and the login keychain does NOT have it
      const inLogin = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "ZAI_API_KEY"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      expect(inLogin.status).not.toBe(0);
      removeSecret("ZAI_API_KEY");
      expect(credentialStatus(resolveEnv({}), "ZAI_API_KEY").source).toBe("absent");
    } finally {
      delete process.env.MODELIZER_KEYCHAIN_FILE;
      execSync(`security delete-keychain "${file}" 2>/dev/null || true`);
    }
  });
});
