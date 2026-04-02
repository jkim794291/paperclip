import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from "../index.js";

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  ac.model = v.model || DEFAULT_OLLAMA_MODEL;
  ac.baseUrl = (v as unknown as Record<string, unknown>).baseUrl || DEFAULT_OLLAMA_URL;
  ac.timeoutSec = 120;
  return ac;
}
