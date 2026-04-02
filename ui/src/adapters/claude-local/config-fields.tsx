import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

const ollamaUrlHint =
  "Optional: Ollama server URL (e.g. http://localhost:11434). When set, Claude Code will use this local Ollama model as its backend instead of Anthropic.";
const ollamaModelHint =
  "Ollama model name to use (e.g. llama3.2, qwen2.5-coder, mistral). Only applies when an Ollama URL is configured.";

export function ClaudeLocalOllamaFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const valuesEx = values as (typeof values & { ollamaBaseUrl?: string; ollamaModel?: string }) | null;
  return (
    <>
      <Field label="Ollama server URL" hint={ollamaUrlHint}>
        <DraftInput
          value={
            isCreate
              ? valuesEx?.ollamaBaseUrl ?? ""
              : eff("adapterConfig", "ollamaBaseUrl", String(config.ollamaBaseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ ...values, ollamaBaseUrl: v } as never)
              : mark("adapterConfig", "ollamaBaseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://localhost:11434"
        />
      </Field>
      <Field label="Ollama model" hint={ollamaModelHint}>
        <DraftInput
          value={
            isCreate
              ? valuesEx?.ollamaModel ?? ""
              : eff("adapterConfig", "ollamaModel", String(config.ollamaModel ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ ...values, ollamaModel: v } as never)
              : mark("adapterConfig", "ollamaModel", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="llama3.2"
        />
      </Field>
    </>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 300),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 300)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
