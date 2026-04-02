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
        input: tc.function.arguments,
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
  let inputTokens = 0;
  let outputTokens = 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send message_start
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

  // content_block_start for text
  res.write(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );
  res.write(sseEvent("ping", { type: "ping" }));

  let accumulatedText = "";

  const ollamaRes = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaReq),
  });

  if (!ollamaRes.ok || !ollamaRes.body) {
    const errText = await ollamaRes.text().catch(() => "");
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `[Ollama error ${ollamaRes.status}: ${errText}]` },
      }),
    );
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    );
    res.write(sseEvent("message_stop", { type: "message_stop" }));
    res.end();
    return;
  }

  const reader = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let lastOllamaMsg: OllamaMessage | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      let parsed: OllamaResponse;
      try {
        parsed = JSON.parse(line) as OllamaResponse;
      } catch {
        continue;
      }

      if (parsed.prompt_eval_count) inputTokens = parsed.prompt_eval_count;
      if (parsed.eval_count) outputTokens = parsed.eval_count;

      const delta = parsed.message?.content ?? "";
      if (delta) {
        accumulatedText += delta;
        res.write(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta },
          }),
        );
      }

      if (parsed.done) {
        lastOllamaMsg = parsed.message;
      }
    }
  }

  // Handle tool calls (usually in the final message)
  let finalStopReason = "end_turn";
  let blockIndex = 1;

  if (lastOllamaMsg?.tool_calls && lastOllamaMsg.tool_calls.length > 0) {
    finalStopReason = "tool_use";
    for (const tc of lastOllamaMsg.tool_calls) {
      const toolId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
      res.write(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: toolId, name: tc.function.name, input: {} },
        }),
      );
      res.write(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(tc.function.arguments),
          },
        }),
      );
      res.write(
        sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }),
      );
      blockIndex++;
    }
  }

  res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finalStopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
  );
  res.write(sseEvent("message_stop", { type: "message_stop" }));
  res.end();

  void accumulatedText; // suppress unused warning
  void inputTokens;
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
