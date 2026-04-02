import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const cwd = asString(config.cwd, process.cwd());
  const probeTimeoutSec = Math.max(1, asNumber(config.probeTimeoutSec, 10));

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "ollama_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "ollama_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check Ollama server is reachable
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutSec * 1000);
    let tagsResponse: Response;
    try {
      tagsResponse = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!tagsResponse.ok) {
      checks.push({
        code: "ollama_server_error",
        level: "error",
        message: `Ollama server returned HTTP ${tagsResponse.status}.`,
        detail: baseUrl,
        hint: "Make sure Ollama is running. Start with `ollama serve`.",
      });
    } else {
      const data = await tagsResponse.json() as Record<string, unknown>;
      const modelList = Array.isArray(data.models) ? data.models : [];
      const modelNames = modelList
        .map((m) => {
          const rec = m as Record<string, unknown>;
          return asString(rec.name, "");
        })
        .filter(Boolean);

      checks.push({
        code: "ollama_server_reachable",
        level: "info",
        message: `Ollama server is reachable at ${baseUrl}.`,
        detail: modelNames.length > 0 ? `Available models: ${modelNames.join(", ")}` : "No models found.",
      });

      const modelAvailable = modelNames.some(
        (n) => n === model || n.startsWith(`${model}:`),
      );
      if (modelAvailable) {
        checks.push({
          code: "ollama_model_available",
          level: "info",
          message: `Model "${model}" is available.`,
        });
      } else {
        checks.push({
          code: "ollama_model_missing",
          level: "warn",
          message: `Model "${model}" was not found in the local Ollama instance.`,
          hint: `Run \`ollama pull ${model}\` to download it.`,
        });
      }
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    checks.push({
      code: "ollama_server_unreachable",
      level: "error",
      message: isTimeout
        ? `Ollama server did not respond within ${probeTimeoutSec}s.`
        : `Could not connect to Ollama at ${baseUrl}.`,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Make sure Ollama is running with `ollama serve`. Check that the baseUrl is correct.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
