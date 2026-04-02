import pc from "picocolors";

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function printOllamaStreamEvent(raw: string, _debug: boolean): void {
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    console.log(raw);
    return;
  }

  const type = asString(parsed.type);

  if (type === "init") {
    const model = asString(parsed.model, "ollama");
    console.log(pc.cyan(`Ollama init (model: ${model})`));
    return;
  }

  if (type === "message") {
    const role = asString(parsed.role);
    const content = asString(parsed.content);
    if (role === "assistant" && content) {
      console.log(pc.green(`assistant: ${content}`));
    }
    return;
  }

  if (type === "result") {
    const statsRaw = parsed.stats;
    const stats =
      typeof statsRaw === "object" && statsRaw !== null && !Array.isArray(statsRaw)
        ? (statsRaw as Record<string, unknown>)
        : {};
    const inputTokens = asNumber(stats.input_tokens);
    const outputTokens = asNumber(stats.output_tokens);
    const status = asString(parsed.status, "result");
    const isError = status === "error";

    if (isError) {
      const errMsg = asString(parsed.error, "unknown error");
      console.log(pc.red(`error: ${errMsg}`));
    } else {
      console.log(pc.dim(`tokens: in=${inputTokens} out=${outputTokens}`));
    }
    return;
  }

  if (type === "error") {
    const msg = asString(parsed.error, asString(parsed.message, raw));
    console.log(pc.red(`error: ${msg}`));
    return;
  }
}
