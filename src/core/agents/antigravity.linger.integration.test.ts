import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityAgent } from "./antigravity.js";

describe("AntigravityAgent linger shutdown (real process)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves after shutting down a child that lingers past a success result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gnhf-agy-linger-"));
    tempDirs.push(dir);
    const bin = join(dir, "linger-agy.mjs");
    const jsonOutput = JSON.stringify({
      success: true,
      summary: "Antigravity real child finished",
      key_changes_made: ["test"],
      key_learnings: ["real child shutdown"],
    });
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  event: "step_update",
  step_update: { state: "RUNNING", text_delta: "streaming message..." }
}) + "\\n");
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: ${JSON.stringify(jsonOutput)},
    usage: { input_tokens: 15, output_tokens: 7 }
  }
}) + "\\n");
setTimeout(() => {}, 60_000);
`,
      "utf8",
    );
    chmodSync(bin, 0o755);

    const started = Date.now();
    let messageReceived = "";
    const agent = new AntigravityAgent({
      bin: process.execPath,
      extraArgs: [bin],
      finalResultGraceMs: 200,
      platform: process.platform === "win32" ? "win32" : "linux",
    });

    const result = await agent.run("prove real child shutdown", dir, {
      onMessage: (delta) => {
        messageReceived += delta;
      },
    });
    const elapsedMs = Date.now() - started;

    expect(result.output.success).toBe(true);
    expect(result.output.summary).toBe("Antigravity real child finished");
    expect(result.usage?.inputTokens).toBe(15);
    expect(result.usage?.outputTokens).toBe(7);
    expect(messageReceived).toBe("streaming message...");
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
