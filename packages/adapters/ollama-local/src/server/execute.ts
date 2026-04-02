import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  joinPromptSections,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from "../index.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime: _runtime, config, context, onLog, onMeta } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const timeoutSec = asNumber(config.timeoutSec, 120);

  const configuredCwd = asString(config.cwd, "");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env = buildPaperclipEnv(agent);

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      const dir = `${path.dirname(instructionsFilePath)}/`;
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${dir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const paperclipEnvKeys = Object.keys(env)
    .filter((k) => k.startsWith("PAPERCLIP_"))
    .sort();
  const envNote =
    paperclipEnvKeys.length > 0
      ? `Paperclip runtime note:\nThe following PAPERCLIP_* environment variables are available: ${paperclipEnvKeys.join(", ")}\n\n`
      : "";

  const prompt = joinPromptSections([instructionsPrefix, envNote, renderedPrompt]);

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command: `${baseUrl}/api/chat`,
      cwd,
      commandNotes: [`HTTP POST to ${baseUrl}/api/chat`, `Model: ${model}`],
      commandArgs: [],
      env: {},
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: 0,
        sessionHandoffChars: 0,
        runtimeNoteChars: envNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  const ts = new Date().toISOString();
  await onLog("stdout", JSON.stringify({ type: "init", model, timestamp: ts }) + "\n");

  const controller = new AbortController();
  const timeoutHandle =
    timeoutSec > 0
      ? setTimeout(() => controller.abort(), timeoutSec * 1000)
      : null;

  let responseText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let timedOut = false;
  let errorMessage: string | null = null;

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama API error ${response.status}: ${body || response.statusText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const message = parseObject(data.message);
    responseText = asString(message.content, "").trim();
    inputTokens = asNumber(data.prompt_eval_count, 0);
    outputTokens = asNumber(data.eval_count, 0);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      timedOut = true;
      errorMessage = `Ollama request timed out after ${timeoutSec}s`;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (responseText) {
    await onLog(
      "stdout",
      JSON.stringify({ type: "message", role: "assistant", content: responseText }) + "\n",
    );
  }

  const status = errorMessage ? "error" : "success";
  await onLog(
    "stdout",
    JSON.stringify({
      type: "result",
      status,
      stats: { input_tokens: inputTokens, output_tokens: outputTokens },
      ...(errorMessage ? { error: errorMessage } : {}),
    }) + "\n",
  );

  return {
    exitCode: errorMessage ? 1 : 0,
    signal: null,
    timedOut,
    errorMessage: errorMessage ?? null,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
    provider: "ollama",
    biller: "local",
    model,
    billingType: "fixed",
    costUsd: 0,
    summary: responseText || null,
    resultJson: { status, response: responseText },
  };
}
