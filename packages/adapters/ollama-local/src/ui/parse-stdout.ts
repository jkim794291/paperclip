import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "init") {
    return [{ kind: "init", ts, model: asString(parsed.model, "ollama"), sessionId: "" }];
  }

  if (type === "message") {
    const role = asString(parsed.role);
    if (role === "assistant") {
      const text = asString(parsed.content).trim();
      return text ? [{ kind: "assistant", ts, text }] : [];
    }
    if (role === "user") {
      const text = asString(parsed.content).trim();
      return text ? [{ kind: "user", ts, text }] : [];
    }
    return [];
  }

  if (type === "result") {
    const statsRaw = asRecord(parsed.stats);
    const inputTokens = asNumber(statsRaw?.input_tokens);
    const outputTokens = asNumber(statsRaw?.output_tokens);
    const status = asString(parsed.status, "result");
    const isError = status === "error" || parsed.is_error === true;
    const errorMsg = asString(parsed.error);
    return [{
      kind: "result",
      ts,
      text: asString(parsed.response),
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      costUsd: 0,
      subtype: status,
      isError,
      errors: isError && errorMsg ? [errorMsg] : [],
    }];
  }

  if (type === "error") {
    const text = asString(parsed.error) || asString(parsed.message) || "error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
