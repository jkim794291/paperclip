/**
 * Local HTTP proxy that translates Anthropic Messages API ↔ Ollama Chat API.
 *
 * When ollamaBaseUrl + ollamaModel are configured on the claude_local adapter,
 * this proxy is started on a random port. The adapter then sets:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *   ANTHROPIC_API_KEY=ollama-local
 *
 * Claude Code CLI sends requests to the proxy, which forwards them to Ollama
 * and converts responses back to Anthropic format.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ─── Types ────────────────────────────────────────────────────────────────────

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] }
  | { type: "thinking"; thinking: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: AnthropicTool[];
  stream?: boolean;
  thinking?: { type: string; budget_tokens?: number };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  stream: boolean;
}

interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Conversion helpers ────────────────────────────────────────────────────────

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try { return JSON.parse(args) as Record<string, unknown>; } catch { return { _raw: args }; }
  }
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function contentToString(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return `<thinking>${b.thinking}</thinking>`;
      if (b.type === "tool_use") return `[Calling tool: ${b.name}(${JSON.stringify(b.input)})]`;
      if (b.type === "tool_result") {
        const result =
          typeof b.content === "string" ? b.content : contentToString(b.content);
        return `[Tool result: ${result}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicToOllamaMessages(req: AnthropicRequest): OllamaMessage[] {
  const messages: OllamaMessage[] = [];

  // Inject system prompt
  const systemText =
    typeof req.system === "string"
      ? req.system
      : Array.isArray(req.system)
        ? req.system
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : "";
  if (systemText.trim()) {
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    messages.push({ role: msg.role, content: contentToString(msg.content) });
  }

  return messages;
}

function anthropicToolsToOllama(tools?: AnthropicTool[]): OllamaRequest["tools"] {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
    },
  }));
}

function ollamaMessageToAnthropicContent(msg: OllamaMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  if (msg.content && msg.content.trim()) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function.name,
        input: parseToolArgs(tc.function.arguments),
      });
    }
  }

  return blocks;
}

function stopReason(msg: OllamaMessage): string {
  if (msg.tool_calls && msg.tool_calls.length > 0) return "tool_use";
  return "end_turn";
}

// ─── Non-streaming response ────────────────────────────────────────────────────

function buildAnthropicResponse(
  ollamaResp: OllamaResponse,
  requestedModel: string,
): Record<string, unknown> {
  const content = ollamaMessageToAnthropicContent(ollamaResp.message);
  return {
    id: `msg_${Math.random().toString(36).slice(2, 16)}`,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel,
    stop_reason: stopReason(ollamaResp.message),
    stop_sequence: null,
    usage: {
      input_tokens: ollamaResp.prompt_eval_count ?? 0,
      output_tokens: ollamaResp.eval_count ?? 0,
    },
  };
}

// ─── Streaming response ────────────────────────────────────────────────────────

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function streamOllamaToAnthropic(
  ollamaBaseUrl: string,
  ollamaReq: OllamaRequest,
  requestedModel: string,
  res: http.ServerResponse,
): Promise<void> {
  const msgId = `msg_${Math.random().toString(36).slice(2, 16)}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: requestedModel,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 1 },
      },
    }),
  );
  res.write(sseEvent("ping", { type: "ping" }));

  // ── Fetch from Ollama ──────────────────────────────────────────────────────
  const ollamaRes = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaReq),
  });

  if (!ollamaRes.ok || !ollamaRes.body) {
    const errText = await ollamaRes.text().catch(() => "");
    process.stderr.write(`[ollama-proxy] Ollama error ${ollamaRes.status}: ${errText}\n`);
    res.write(sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `[Ollama error ${ollamaRes.status}: ${errText}]` } }));
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }));
    res.write(sseEvent("message_stop", { type: "message_stop" }));
    res.end();
    return;
  }

  // ── Stream Ollama NDJSON, accumulate text and final message ────────────────
  const reader = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let lastOllamaMsg: OllamaMessage | null = null;
  let outputTokens = 0;

  // We need to collect whether there's text before opening the text block,
  // because if the model only returns tool_calls we skip the text block entirely.
  // Strategy: buffer all NDJSON lines, process after reading is complete.
  const lines: OllamaResponse[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try { lines.push(JSON.parse(line) as OllamaResponse); } catch { /* skip */ }
    }
  }

  // Collect text deltas and final message
  const textDeltas: string[] = [];
  for (const parsed of lines) {
    if (parsed.eval_count) outputTokens = parsed.eval_count;
    const delta = parsed.message?.content ?? "";
    if (delta) textDeltas.push(delta);
    if (parsed.done) lastOllamaMsg = parsed.message;
  }

  const hasText = textDeltas.length > 0;
  const toolCalls = lastOllamaMsg?.tool_calls ?? [];
  const hasToolCalls = toolCalls.length > 0;

  process.stderr.write(
    `[ollama-proxy] response: hasText=${hasText} toolCalls=${toolCalls.length} outputTokens=${outputTokens}\n`,
  );

  let blockIndex = 0;

  // ── 1. Text block (only if there is text) ─────────────────────────────────
  if (hasText) {
    res.write(sseEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }));
    for (const delta of textDeltas) {
      res.write(sseEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta } }));
    }
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    blockIndex++;
  }

  // ── 2. Tool call blocks (AFTER text block is fully closed) ────────────────
  for (const tc of toolCalls) {
    const toolId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
    const argsObj = parseToolArgs(tc.function.arguments);
    res.write(sseEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: toolId, name: tc.function.name, input: {} } }));
    res.write(sseEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(argsObj) } }));
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    blockIndex++;
  }

  // ── 3. End stream ──────────────────────────────────────────────────────────
  const finalStopReason = hasToolCalls ? "tool_use" : "end_turn";
  res.write(sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }));
  res.write(sseEvent("message_stop", { type: "message_stop" }));
  res.end();
}

// ─── Request handler ───────────────────────────────────────────────────────────

async function handleMessagesRequest(
  ollamaBaseUrl: string,
  ollamaModel: string,
  body: string,
  res: http.ServerResponse,
): Promise<void> {
  let req: AnthropicRequest;
  try {
    req = JSON.parse(body) as AnthropicRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const ollamaReq: OllamaRequest = {
    model: ollamaModel,
    messages: anthropicToOllamaMessages(req),
    tools: anthropicToolsToOllama(req.tools),
    stream: req.stream ?? false,
  };

  process.stderr.write(
    `[ollama-proxy] → ${req.model} stream=${req.stream ?? false} msgs=${ollamaReq.messages.length} tools=${ollamaReq.tools?.length ?? 0}\n`,
  );

  if (req.stream) {
    await streamOllamaToAnthropic(ollamaBaseUrl, ollamaReq, req.model, res);
    return;
  }

  // Non-streaming
  const ollamaRes = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaReq),
  });

  if (!ollamaRes.ok) {
    const errText = await ollamaRes.text().catch(() => "");
    res.writeHead(ollamaRes.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "api_error", message: errText } }));
    return;
  }

  const ollamaData = (await ollamaRes.json()) as OllamaResponse;
  const anthropicResp = buildAnthropicResponse(ollamaData, req.model);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(anthropicResp));
}

// ─── Server ────────────────────────────────────────────────────────────────────

export async function startOllamaProxy(
  ollamaBaseUrl: string,
  ollamaModel: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    // Handle CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");

      if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
        handleMessagesRequest(ollamaBaseUrl, ollamaModel, body, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: { type: "server_error", message: String(err) } }));
        });
        return;
      }

      // Health check / unknown routes
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ollama-proxy" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = (server.address() as AddressInfo).port;

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  return { port, stop };
}
