import type { AdapterConfigFieldsProps } from "../types";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OllamaLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const baseUrlValue = isCreate
    ? ((values as unknown as Record<string, unknown>)?.baseUrl as string) ?? DEFAULT_OLLAMA_URL
    : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? DEFAULT_OLLAMA_URL));

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">Ollama Server URL</label>
      <input
        type="text"
        className={inputClass}
        placeholder={DEFAULT_OLLAMA_URL}
        value={baseUrlValue}
        onChange={(e) => {
          const v = e.target.value;
          if (isCreate) {
            set?.({ ...(values ?? {}), baseUrl: v } as never);
          } else {
            mark("adapterConfig", "baseUrl", v || DEFAULT_OLLAMA_URL);
          }
        }}
      />
      <p className="text-xs text-muted-foreground">
        URL of the running Ollama instance. Defaults to {DEFAULT_OLLAMA_URL}.
      </p>
    </div>
  );
}
