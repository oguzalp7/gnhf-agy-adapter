import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { AntigravityAgent, buildAntigravityArgs, resolveAntigravityBin } from "./antigravity.js";
import { buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function withTemporaryPath(candidates: string[], callback: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "gnhf-agy-path-"));
  const originalPath = process.env.PATH;
  try {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      writeFileSync(path, "");
      chmodSync(path, 0o755);
    }
    process.env.PATH = directory;
    callback();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("AntigravityAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReset();
  });

  describe("resolveAntigravityBin", () => {
    it("finds agy on PATH when available", () => {
      withTemporaryPath(["agy"], () => {
        expect(resolveAntigravityBin("linux")).toBe("agy");
      });
    });

    it("falls back to antigravity on PATH", () => {
      withTemporaryPath(["antigravity"], () => {
        expect(resolveAntigravityBin("linux")).toBe("antigravity");
      });
    });

    it("defaults to agy when neither is found", () => {
      withTemporaryPath([], () => {
        expect(resolveAntigravityBin("linux")).toBe("agy");
      });
    });
  });

  describe("buildAntigravityArgs", () => {
    const schema = buildAgentOutputSchema({ includeStopField: false });

    it("includes standard print and json-schema flags", () => {
      const args = buildAntigravityArgs("do something", schema);
      expect(args).toEqual([
        "-p",
        "do something",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        JSON.stringify(schema),
        "--dangerously-skip-permissions",
      ]);
    });

    it("preserves user extraArgs", () => {
      const args = buildAntigravityArgs("do something", schema, ["--model", "gemini-3.8-flash"]);
      expect(args).toContain("--model");
      expect(args).toContain("gemini-3.8-flash");
      expect(args).toContain("--dangerously-skip-permissions");
    });
  });

  describe("run", () => {
    const schema = buildAgentOutputSchema({ includeStopField: false });

    it("resolves valid output and token usage from stream-json", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const agent = new AntigravityAgent({ schema });
      const onMessage = vi.fn();
      const onUsage = vi.fn();

      const runPromise = agent.run("test task", "/workspace", { onMessage, onUsage });

      // Simulate stream events
      emitJson(proc, {
        event: "step_update",
        step_update: { state: "ACTIVE", text_delta: "Working on it..." },
      });
      emitJson(proc, {
        event: "step_update",
        step_update: {
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      });

      const validResponse = JSON.stringify({
        success: true,
        summary: "Implemented test feature",
        key_changes_made: ["Modified foo.ts"],
        key_learnings: ["Bar works"],
      });

      emitJson(proc, {
        event: "result",
        result: {
          status: "SUCCESS",
          response: validResponse,
          usage: { input_tokens: 150, output_tokens: 50 },
        },
      });

      proc.emit("close", 0, null);

      const result = await runPromise;
      expect(result.output.success).toBe(true);
      expect(result.output.summary).toBe("Implemented test feature");
      expect(result.usage.inputTokens).toBe(150);
      expect(result.usage.outputTokens).toBe(50);
      expect(onMessage).toHaveBeenCalledWith("Working on it...");
      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 150,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    });

    it("rejects when process exits with error status", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const agent = new AntigravityAgent({ schema });
      const runPromise = agent.run("test task", "/workspace");

      emitJson(proc, {
        event: "result",
        result: {
          status: "ERROR",
          error: "Permission denied",
        },
      });

      proc.emit("close", 1, null);

      await expect(runPromise).rejects.toThrow("Antigravity failed with status ERROR: Permission denied");
    });
  });
});
