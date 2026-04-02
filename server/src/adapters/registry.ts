import type { ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@paperclipai/adapter-pi-local";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  execute as hermesExecuteBase,
  testEnvironment as hermesTestEnvironmentBase,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";

const execFileAsync = promisify(execFile);

/** Returns true if any of the given Python executables is version 3.10+. */
async function hasCompatiblePython(candidates: string[]): Promise<boolean> {
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, ["--version"], { timeout: 5_000 });
      const match = stdout.trim().match(/(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major > 3 || (major === 3 && minor >= 10)) return true;
      }
    } catch {
      // not found or failed — try next
    }
  }
  return false;
}

/**
 * Returns true when ~/.hermes/config.yaml (or HERMES_HOME/config.yaml) has a
 * custom model base_url configured, indicating a local/self-hosted provider
 * that doesn't require a cloud API key.
 */
async function hermesHasCustomProvider(): Promise<boolean> {
  const hermesHome = process.env.HERMES_HOME ?? `${homedir()}/.hermes`;
  try {
    const yaml = await readFile(`${hermesHome}/config.yaml`, "utf-8");
    // Simple check: look for a non-empty base_url under the model section.
    return /^\s*base_url:\s*https?:\/\/.+/m.test(yaml);
  } catch {
    return false;
  }
}

/**
 * Wraps hermesTestEnvironment to:
 * 1. Downgrade the Python version error when python3.11+ is available under a
 *    versioned name (handles macOS shipping old system python3).
 * 2. Downgrade the "no API keys" warning when Hermes is configured to use a
 *    local/custom provider (e.g. Ollama) that doesn't need cloud keys.
 */
async function hermesTestEnvironment(ctx: AdapterEnvironmentTestContext) {
  const result = await hermesTestEnvironmentBase(ctx);
  const checks = [...result.checks];

  // ── 1. Python version check ────────────────────────────────────────────────
  const pythonErrorIdx = checks.findIndex(
    (c) => c.code === "hermes_python_old" && c.level === "error",
  );
  if (pythonErrorIdx !== -1) {
    const compat = await hasCompatiblePython(["python3.13", "python3.12", "python3.11", "python3.10"]);
    if (compat) {
      checks[pythonErrorIdx] = {
        ...checks[pythonErrorIdx],
        level: "info",
        message: checks[pythonErrorIdx].message.replace(
          "— Hermes requires Python 3.10+",
          "as system python3; a compatible Python 3.10+ is available via python3.11+",
        ),
        hint: "Hermes is running on a compatible Python. The system python3 symlink is outdated but will not affect execution.",
      };
    }
  }

  // ── 2. No API keys warning when using a local/custom provider ────────────
  const noKeysIdx = checks.findIndex(
    (c) => c.code === "hermes_no_api_keys" && c.level === "warn",
  );
  if (noKeysIdx !== -1) {
    const hasCustom = await hermesHasCustomProvider();
    if (hasCustom) {
      checks[noKeysIdx] = {
        ...checks[noKeysIdx],
        level: "info",
        message: "No cloud API keys set — Hermes is configured to use a local/custom provider.",
        hint: "Set ANTHROPIC_API_KEY etc. only if you want to use a cloud provider instead of your local Ollama/custom endpoint.",
      };
    }
  }

  // Re-evaluate overall status.
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");
  return {
    ...result,
    checks,
    status: (hasErrors ? "fail" : hasWarnings ? "warn" : "pass") as typeof result.status,
  };
}

/**
 * Safe prompt template that avoids `curl | python3 -c` patterns which trigger
 * Hermes's Tirith security scanner. The LLM can parse raw JSON responses
 * directly, so python3 post-processing is not needed.
 */
const HERMES_SAFE_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use the \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent, post a brief notification on the parent issue:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}"\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}"\`
   Read the JSON response and filter for issues where status is not done or cancelled.

2. If issues found, pick the highest priority one and work on it:
   - Read the issue details: \`curl -s "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog"\`
   Read the JSON and look for issues with no assigneeAgentId.
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

/**
 * Wraps hermesExecute to inject a safe prompt template when the user has not
 * configured a custom one. The default template in hermes-paperclip-adapter
 * uses `curl | python3 -c "..."` which triggers Hermes's Tirith security
 * scanner and causes commands to be blocked at runtime.
 */
function hermesExecute(ctx: AdapterExecutionContext) {
  const config = ctx.config as Record<string, unknown>;
  const hasCustomTemplate =
    typeof config.promptTemplate === "string" && config.promptTemplate.trim().length > 0;
  if (hasCustomTemplate) return hermesExecuteBase(ctx);
  return hermesExecuteBase({
    ...ctx,
    config: { ...config, promptTemplate: HERMES_SAFE_PROMPT_TEMPLATE },
  });
}

import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: hermesExecute,
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

const adaptersByType = new Map<string, ServerAdapterModule>(
  [
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ].map((a) => [a.type, a]),
);

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types
    return processAdapter;
  }
  return adapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string } | null> {
  const adapter = adaptersByType.get(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  return detected ? { model: detected.model, provider: detected.provider, source: detected.source } : null;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}
