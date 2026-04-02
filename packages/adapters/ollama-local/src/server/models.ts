import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_URL, models as staticModels } from "../index.js";

export async function listOllamaModels(
  config?: Record<string, unknown>,
): Promise<{ id: string; label: string }[]> {
  const baseUrl = asString(
    parseObject(config).baseUrl,
    DEFAULT_OLLAMA_URL,
  ).replace(/\/$/, "");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return staticModels;

    const data = await response.json() as Record<string, unknown>;
    const modelList = Array.isArray(data.models) ? data.models : [];
    const discovered = modelList
      .map((m) => {
        const rec = m as Record<string, unknown>;
        const name = asString(rec.name, "").trim();
        if (!name) return null;
        // Strip tag suffix for label (e.g. "llama3.2:latest" -> "Llama3.2")
        const base = name.split(":")[0];
        const label = base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        return { id: name, label };
      })
      .filter((m): m is { id: string; label: string } => m !== null);

    return discovered.length > 0 ? discovered : staticModels;
  } catch {
    return staticModels;
  }
}
