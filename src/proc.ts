import { spawn } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /** The executable was not on PATH. Callers should fall back quietly. */
  missing: boolean;
}

/**
 * Run a local CLI. Stdin is closed (`ignore`, same as `</dev/null`) so a prompt
 * cannot wait for input. The timer always settles the promise, then SIGKILL.
 * Stdout is capped so a noisy process cannot fill memory.
 */
export function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.unref();
      finish({ code: null, stdout, stderr, error: "timeout", missing: false });
    }, timeoutMs);
    child.stdout?.on("data", (buf: Buffer) => {
      if (stdout.length < 100_000) stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (stderr.length < 8_000) stderr += buf.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT" || err.message.includes("ENOENT");
      finish({ code: null, stdout, stderr, error: err.message, missing });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, missing: false });
    });
  });
}
