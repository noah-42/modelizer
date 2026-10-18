import { describe, expect, test } from "bun:test";
import { runCommand } from "./proc";

describe("runCommand", () => {
  test("closed stdin and a short timeout always settle", async () => {
    const started = Date.now();
    const result = await runCommand("sleep", ["30"], 400);
    expect(result.error).toBe("timeout");
    expect(result.missing).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});