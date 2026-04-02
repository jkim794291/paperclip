export const type = "ollama_local";
export const label = "Ollama (local)";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

export const models = [
  { id: "llama3.2", label: "Llama 3.2" },
  { id: "llama3.1", label: "Llama 3.1" },
  { id: "llama3.3", label: "Llama 3.3" },
  { id: "mistral", label: "Mistral" },
  { id: "codellama", label: "Code Llama" },
  { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
  { id: "qwen2.5-coder", label: "Qwen 2.5 Coder" },
  { id: "gemma3", label: "Gemma 3" },
  { id: "phi4", label: "Phi 4" },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want to run a local LLM via Ollama as a Paperclip agent
- You have Ollama installed and running on the host machine
- You want to use open-source models without API keys

Don't use when:
- You need a full agentic coding loop with tool use (use claude_local or gemini_local)
- Ollama is not installed or not running

Core fields:
- baseUrl (string, optional): Ollama server URL. Defaults to http://localhost:11434
- model (string, optional): Ollama model name. Defaults to ${DEFAULT_OLLAMA_MODEL}
- promptTemplate (string, optional): run prompt template
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- timeoutSec (number, optional): request timeout in seconds (default: 120)

Notes:
- Ollama must be running before the agent executes. Start with \`ollama serve\`.
- Pull models with \`ollama pull <model>\` before use.
- Model list is dynamically fetched from the Ollama server.
- Authentication is not required for local Ollama instances.
`;
