import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  readdirSync,
  statSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import {
  buildAgentOutputSchema,
  parseAgentOutput,
  PermanentAgentError,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import { shutdownChildProcess } from "./managed-process.js";
import {
  appendExitOutputTail,
  describeChildProcessExit,
  parseJSONLStream,
  setupAbortHandler,
} from "./stream-utils.js";

const DEFAULT_FINAL_RESULT_EXIT_GRACE_MS = 15_000;
const AGY_BIN_CANDIDATES = ["agy", "antigravity"] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateExistsOnPath(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return isExecutableFile(posix.join(directory, candidate));
  }

  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  const expectedNames = new Set(
    [candidate, ...extensions.map((extension) => candidate + extension)].map(
      (name) => name.toLowerCase(),
    ),
  );

  try {
    return readdirSync(directory).some(
      (name) =>
        expectedNames.has(name.toLowerCase()) &&
        isFile(win32.join(directory, name)),
    );
  } catch {
    return false;
  }
}

export function resolveAntigravityBin(platform: NodeJS.Platform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  for (const candidate of AGY_BIN_CANDIDATES) {
    if (
      directories.some((directory) =>
        candidateExistsOnPath(directory, candidate, platform),
      )
    ) {
      return candidate;
    }
  }
  return AGY_BIN_CANDIDATES[0];
}

export interface AntigravityAgentDeps {
  bin?: string;
  extraArgs?: string[];
  finalResultGraceMs?: number;
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

interface AntigravityStepUpdateEvent {
  event: "step_update";
  step_update?: {
    state?: string;
    step_type?: string;
    text_delta?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      thinking_tokens?: number;
    };
  };
}

interface AntigravityResultEvent {
  event: "result";
  result?: {
    status?: string;
    response?: string;
    error?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      thinking_tokens?: number;
    };
  };
}

type AntigravityEvent =
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | { event: string };

function isStepUpdateEvent(
  event: AntigravityEvent,
): event is AntigravityStepUpdateEvent {
  return event.event === "step_update" && "step_update" in event;
}

function isResultEvent(
  event: AntigravityEvent,
): event is AntigravityResultEvent {
  return event.event === "result" && "result" in event;
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminateAntigravityProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort
    }
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back
    }
  }

  child.kill("SIGTERM");
}

async function shutdownAntigravityProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    terminateAntigravityProcess(child, platform);
    return;
  }

  await shutdownChildProcess(child, {
    detached: true,
  });
}

export function buildAntigravityArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedPermissionMode = userArgs.some(
    (arg) =>
      arg === "--dangerously-skip-permissions" ||
      arg.startsWith("--dangerously-skip-permissions"),
  );

  return [
    ...userArgs,
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(schema),
    ...(userSpecifiedPermissionMode ? [] : ["--dangerously-skip-permissions"]),
  ];
}

function toTokenUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  thinking_tokens?: number;
}): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_tokens ?? 0,
    cacheCreationTokens: 0,
  };
}

export class AntigravityAgent implements Agent {
  name = "antigravity";

  private bin: string;
  private extraArgs?: string[];
  private finalResultGraceMs: number;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | AntigravityAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.platform = deps.platform ?? process.platform;
    this.bin = deps.bin ?? resolveAntigravityBin(this.platform);
    this.extraArgs = deps.extraArgs;
    this.finalResultGraceMs =
      deps.finalResultGraceMs ?? DEFAULT_FINAL_RESULT_EXIT_GRACE_MS;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(
        this.bin,
        buildAntigravityArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          detached: this.platform !== "win32",
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      let settled = false;
      let resultEvent: AntigravityResultEvent | null = null;
      let finalResultCleanupTimer: ReturnType<typeof setTimeout> | null = null;
      let closedAfterFinalCleanup = false;
      let stderr = "";
      let stdoutTail = "";
      let latestUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      const cleanupResources = () => {
        if (finalResultCleanupTimer) {
          clearTimeout(finalResultCleanupTimer);
          finalResultCleanupTimer = null;
        }
      };

      const settleSuccess = () => {
        if (settled) return;
        settled = true;
        cleanupResources();

        if (resultEvent?.result?.status === "SUCCESS" && resultEvent.result?.response) {
          try {
            const output = parseAgentOutput(
              resultEvent.result.response,
              this.schema,
              "Antigravity",
            );
            resolve({
              output,
              usage: latestUsage,
            });
          } catch (err) {
            reject(
              new Error(
                `Antigravity result was not valid: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        }
      };

      const settleFailure = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanupResources();
        reject(err);
      };

      if (
        setupAbortHandler(signal, child, reject, () => {
          settled = true;
          cleanupResources();
          void shutdownAntigravityProcess(child, this.platform);
        })
      ) {
        logStream?.end();
        return;
      }

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdout!.on("data", (data: Buffer) => {
        stdoutTail = appendExitOutputTail(stdoutTail, data.toString());
      });

      child.on("error", (err) => {
        logStream?.end();
        settleFailure(new Error(`Failed to spawn antigravity: ${err.message}`));
      });

      parseJSONLStream<AntigravityEvent>(child.stdout!, logStream, (event) => {
        if (isStepUpdateEvent(event)) {
          if (event.step_update?.text_delta && onMessage) {
            onMessage(event.step_update.text_delta);
          }
          if (event.step_update?.usage) {
            latestUsage = toTokenUsage(event.step_update.usage);
            if (onUsage) {
              onUsage(latestUsage);
            }
          }
        } else if (isResultEvent(event)) {
          resultEvent = event;
          if (resultEvent.result?.usage) {
            latestUsage = toTokenUsage(resultEvent.result.usage);
            if (onUsage) {
              onUsage(latestUsage);
            }
          }
          if (
            resultEvent.result?.status === "SUCCESS" &&
            resultEvent.result?.response
          ) {
            if (finalResultCleanupTimer) {
              clearTimeout(finalResultCleanupTimer);
            }
            finalResultCleanupTimer = setTimeout(() => {
              closedAfterFinalCleanup = true;
              void shutdownAntigravityProcess(child, this.platform).then(() => {
                if (resultEvent?.result?.status === "SUCCESS" && resultEvent.result?.response) {
                  settleSuccess();
                }
              });
            }, this.finalResultGraceMs);
          }
        }
      });

      child.on("close", (code) => {
        logStream?.end();
        if (settled) return;

        if (signal?.aborted) {
          settled = true;
          cleanupResources();
          return;
        }

        if (resultEvent?.result?.status === "SUCCESS" && resultEvent.result?.response) {
          settleSuccess();
          return;
        }

        if (code !== 0 && !closedAfterFinalCleanup) {
          if (resultEvent?.result?.status && resultEvent.result.status !== "SUCCESS") {
            settleFailure(
              new Error(
                `Antigravity failed with status ${resultEvent.result.status}: ${resultEvent.result.error || stderr || "unknown error"}`,
              ),
            );
            return;
          }

          const exitDescription = describeChildProcessExit(
            "Antigravity",
            code,
            stdoutTail,
            stderr,
          ).detail;
          const details = stderr.trim() || stdoutTail.trim() || exitDescription;
          settleFailure(new Error(`Antigravity exited prematurely: ${details}`));
          return;
        }

        if (resultEvent?.result?.status && resultEvent.result.status !== "SUCCESS") {
          settleFailure(
            new Error(
              `Antigravity failed with status ${resultEvent.result.status}: ${resultEvent.result.error || stderr || "unknown error"}`,
            ),
          );
          return;
        }

        const exitDescription = describeChildProcessExit(
          "Antigravity",
          code,
          stdoutTail,
          stderr,
        ).detail;
        const details = stderr.trim() || stdoutTail.trim() || exitDescription;
        settleFailure(new Error(`Antigravity exited prematurely: ${details}`));
      });
    });
  }
}
