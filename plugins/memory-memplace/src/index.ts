/**
 * memory-memplace/src/index.ts
 *
 * OpenClaw native plugin — MemPlace MCP semantic memory client.
 *
 * Architecture overview:
 *  ┌──────────────────────────────────────────────────────┐
 *  │  OpenClaw Agent Core                                 │
 *  │                                                      │
 *  │  PluginContext ──► MemPlacePlugin                    │
 *  │      │                 │                             │
 *  │      │ events          │ MCP Client (stdio)          │
 *  │      │ tools           │                             │
 *  │      │ logger          ▼                             │
 *  │      │            mempalace process                  │
 *  │      │            (Python, MCP server)               │
 *  └──────┴──────────────────────────────────────────────-┘
 *
 * MCP tools used:
 *   search              → memory_search
 *   mempalace_add_drawer → memory_add
 *   status              → memory_status
 *   diary_write         → flushToDiary (auto-capture on pre-compact)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Types that @openclaw/plugin-sdk would export ────────────────────────────
// We define local interfaces matching the OpenClaw plugin SDK contract so this
// file compiles without the optional peer dep being installed in CI.

/** Severity levels for the plugin logger */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): PluginLogger;
}

/** A registered tool definition */
interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; [key: string]: unknown }>;
    required?: string[];
  };
  handler: (input: TInput) => Promise<ToolResult>;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface ToolRegistry {
  register<TInput extends Record<string, unknown>>(tool: ToolDefinition<TInput>): void;
}

interface PluginEventEmitter {
  on(event: string, handler: (payload: unknown) => Promise<void> | void): void;
  off(event: string, handler: (payload: unknown) => Promise<void> | void): void;
}

/** Pre-compact event payload emitted by OpenClaw before context reduction */
interface PreCompactEvent {
  transcript: string;
  tokenCount: number;
  reason: 'scheduled' | 'overflow' | 'manual';
}

/** Pre-turn event payload emitted before each agent reasoning step */
interface PreTurnEvent {
  query: string;
  sessionId: string;
}

/** Validated config for this plugin (mirrors configSchema in openclaw.plugin.json) */
interface MemPlaceConfig {
  mcpPath: string;
  autoRecall: boolean;
  autoCapture: boolean;
  topKDefault?: number;
  connectionTimeoutMs?: number;
}

/** The PluginContext injected by OpenClaw at activation time */
interface PluginContext {
  pluginId: string;
  config: MemPlaceConfig;
  logger: PluginLogger;
  tools: ToolRegistry;
  events: PluginEventEmitter;
}

/** The MemoryProvider interface from @openclaw/plugin-sdk */
interface MemoryProvider {
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  search(query: string, topK: number): Promise<MemoryRecord[]>;
}

interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  tags: string[];
  createdAt: string;
}

// ─── MCP response shape helpers ──────────────────────────────────────────────

function extractTextContent(result: any): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text') {
      parts.push(item.text);
    } else {
      // Serialize non-text content to a readable string
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join('\n');
}

function isPreCompactEvent(payload: unknown): payload is PreCompactEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'transcript' in payload &&
    typeof (payload as Record<string, unknown>)['transcript'] === 'string'
  );
}

function isPreTurnEvent(payload: unknown): payload is PreTurnEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'query' in payload &&
    typeof (payload as Record<string, unknown>)['query'] === 'string'
  );
}

// ─── Main plugin class ────────────────────────────────────────────────────────

class MemPlacePlugin implements MemoryProvider {
  private readonly ctx: PluginContext;
  private readonly mcpClient: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;

  /**
   * Store bound event handlers so we can unsubscribe them in deactivate().
   */
  private readonly onPreCompact: (payload: unknown) => Promise<void>;
  private readonly onPreTurn: (payload: unknown) => Promise<void>;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;

    const timeoutMs = ctx.config.connectionTimeoutMs ?? 5000;

    // Create the stdio transport targeting the mempalace process
    this.transport = new StdioClientTransport({
      command: ctx.config.mcpPath,
      args: ['mcp'],
      env: {
        ...process.env as Record<string, string>,
        // Pass through PATH so the subprocess can resolve its own deps
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      },
    });

    this.mcpClient = new Client(
      {
        name: 'openclaw-memory-memplace',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    // Bind handlers once so they remain the same references for removal
    this.onPreCompact = this.handlePreCompact.bind(this);
    this.onPreTurn = this.handlePreTurn.bind(this);

    void timeoutMs; // used below in activate()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async activate(): Promise<void> {
    const timeoutMs = this.ctx.config.connectionTimeoutMs ?? 5000;
    this.ctx.logger.info(`[memory-memplace] Connecting to MemPlace MCP server at: ${this.ctx.config.mcpPath}`);

    try {
      // Race the connection against a timeout to avoid hanging the agent startup
      await Promise.race([
        this.mcpClient.connect(this.transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP connection timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);

      this.connected = true;
      this.ctx.logger.info('[memory-memplace] Connected to MemPlace MCP server successfully.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`[memory-memplace] Failed to connect to MCP server: ${message}`);
      throw new Error(`MemPlace MCP connection failed: ${message}`);
    }

    // Register tools into the OpenClaw tool registry
    this.registerTools();

    // Subscribe to lifecycle events
    if (this.ctx.config.autoCapture) {
      this.ctx.events.on('context:pre-compact', this.onPreCompact);
      this.ctx.logger.info('[memory-memplace] autoCapture enabled — listening for context:pre-compact events.');
    }

    if (this.ctx.config.autoRecall) {
      this.ctx.events.on('context:pre-turn', this.onPreTurn);
      this.ctx.logger.info('[memory-memplace] autoRecall enabled — listening for context:pre-turn events.');
    }
  }

  async deactivate(): Promise<void> {
    this.ctx.logger.info('[memory-memplace] Deactivating plugin...');

    // Remove event listeners
    this.ctx.events.off('context:pre-compact', this.onPreCompact);
    this.ctx.events.off('context:pre-turn', this.onPreTurn);

    if (this.connected) {
      try {
        await this.mcpClient.close();
        this.connected = false;
        this.ctx.logger.info('[memory-memplace] MCP client disconnected cleanly.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.logger.warn(`[memory-memplace] Error during MCP client close: ${message}`);
      }
    }
  }

  // ── MemoryProvider interface ───────────────────────────────────────────────

  /**
   * Programmatic search used by OpenClaw memory subsystem and auto-recall.
   */
  async search(query: string, topK: number): Promise<MemoryRecord[]> {
    this.assertConnected();

    let result: any;
    try {
      result = await this.mcpClient.callTool({
        name: 'search',
        arguments: { query, top_k: topK },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`[memory-memplace] search MCP call failed: ${message}`);
      throw new Error(`memory_search failed: ${message}`);
    }

    const raw = extractTextContent(result);

    // MemPlace returns a JSON array of memory objects; parse defensively
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // If not JSON, wrap the raw text as a single unstructured record
      return [
        {
          id: 'raw-result',
          content: raw,
          score: 1.0,
          tags: [],
          createdAt: new Date().toISOString(),
        },
      ];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((item: unknown, index: number): MemoryRecord => {
      if (typeof item !== 'object' || item === null) {
        return { id: String(index), content: String(item), score: 0, tags: [], createdAt: '' };
      }
      const obj = item as Record<string, unknown>;
      return {
        id: typeof obj['id'] === 'string' ? obj['id'] : String(index),
        content: typeof obj['content'] === 'string' ? obj['content'] : JSON.stringify(obj),
        score: typeof obj['score'] === 'number' ? obj['score'] : 0,
        tags: Array.isArray(obj['tags'])
          ? (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        createdAt: typeof obj['created_at'] === 'string' ? obj['created_at'] : '',
      };
    });
  }

  // ── Tool Registration ──────────────────────────────────────────────────────

  private registerTools(): void {
    const logger = this.ctx.logger.child({ component: 'tools' });

    // ── Tool: memory_search ──────────────────────────────────────────────────
    this.ctx.tools.register<{ query: string; topK?: number }>({
      name: 'memory_search',
      description:
        'Search the MemPlace semantic memory palace for relevant stored knowledge, decisions, patterns, or past insights. Use this before making architectural decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query describing what you are looking for.',
          },
          topK: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5, max: 50).',
          },
        },
        required: ['query'],
      },
      handler: async (input) => {
        const query = input.query.trim();
        if (query.length === 0) {
          return { content: 'Error: query must not be empty.', isError: true };
        }
        const topK = Math.min(Math.max(1, input.topK ?? this.ctx.config.topKDefault ?? 5), 50);

        logger.info(`memory_search: query="${query}" topK=${topK}`);

        try {
          const records = await this.search(query, topK);
          if (records.length === 0) {
            return { content: 'No memories found matching the query.' };
          }
          const formatted = records
            .map(
              (r, i) =>
                `## Result ${i + 1} (score: ${r.score.toFixed(3)})\n` +
                `**ID:** ${r.id}\n` +
                (r.tags.length > 0 ? `**Tags:** ${r.tags.join(', ')}\n` : '') +
                `\n${r.content}`
            )
            .join('\n\n---\n\n');
          return { content: formatted };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`memory_search handler error: ${message}`);
          return { content: `Search failed: ${message}`, isError: true };
        }
      },
    });

    // ── Tool: memory_add ────────────────────────────────────────────────────
    this.ctx.tools.register<{ content: string; tags?: string[] }>({
      name: 'memory_add',
      description:
        'Store a new piece of knowledge, decision, pattern, or insight into MemPlace for future recall. Accepts optional tags for categorisation.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The text content to store in the memory palace.',
          },
          tags: {
            type: 'array',
            description: 'Optional list of string tags to categorise this memory (e.g. ["architecture","typescript"]).',
            items: { type: 'string', description: 'A single tag string.' },
          },
        },
        required: ['content'],
      },
      handler: async (input) => {
        const content = input.content.trim();
        if (content.length === 0) {
          return { content: 'Error: content must not be empty.', isError: true };
        }
        const tags: string[] = Array.isArray(input.tags)
          ? input.tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
          : [];

        logger.info(`memory_add: content length=${content.length} tags=[${tags.join(',')}]`);

        try {
          this.assertConnected();
          const result = await this.mcpClient.callTool({
            name: 'mempalace_add_drawer',
            arguments: { content, tags },
          });
          const responseText = extractTextContent(result);
          return { content: `Memory stored successfully.\n\n${responseText}` };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`memory_add handler error: ${message}`);
          return { content: `Failed to store memory: ${message}`, isError: true };
        }
      },
    });

    // ── Tool: memory_status ─────────────────────────────────────────────────
    this.ctx.tools.register<Record<string, never>>({
      name: 'memory_status',
      description:
        'Query the current health and statistics of the MemPlace memory palace server: drawer count, vector index size, uptime, etc.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async (_input) => {
        logger.info('memory_status: querying MemPlace server status');

        try {
          this.assertConnected();
          const result = await this.mcpClient.callTool({
            name: 'status',
            arguments: {},
          });
          return { content: extractTextContent(result) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`memory_status handler error: ${message}`);
          return {
            content: `MemPlace status check failed: ${message}\nMCP server may be offline.`,
            isError: true,
          };
        }
      },
    });

    logger.info('[memory-memplace] Registered 3 tools: memory_search, memory_add, memory_status');
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  /**
   * context:pre-compact — flush transcript to MemPlace diary before compaction.
   */
  private async handlePreCompact(payload: unknown): Promise<void> {
    if (!isPreCompactEvent(payload)) {
      this.ctx.logger.warn('[memory-memplace] pre-compact event has unexpected shape; skipping diary write.');
      return;
    }

    this.ctx.logger.info(
      `[memory-memplace] context:pre-compact triggered (reason=${payload.reason}, tokens=${payload.tokenCount}). Flushing transcript to diary...`
    );

    try {
      await this.flushToDiary(payload.transcript);
      this.ctx.logger.info('[memory-memplace] Transcript flushed to MemPlace diary successfully.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal: log the error but do not abort compaction
      this.ctx.logger.error(`[memory-memplace] diary flush failed (non-fatal): ${message}`);
    }
  }

  /**
   * context:pre-turn — auto-recall relevant memories before the agent processes a new turn.
   */
  private async handlePreTurn(payload: unknown): Promise<void> {
    if (!isPreTurnEvent(payload)) {
      this.ctx.logger.warn('[memory-memplace] pre-turn event has unexpected shape; skipping auto-recall.');
      return;
    }

    const query = payload.query.trim();
    if (query.length === 0) {
      return;
    }

    this.ctx.logger.debug(`[memory-memplace] auto-recall: query="${query.slice(0, 80)}..."`);

    try {
      const topK = this.ctx.config.topKDefault ?? 5;
      const records = await this.search(query, topK);
      if (records.length > 0) {
        this.ctx.logger.info(
          `[memory-memplace] auto-recall retrieved ${records.length} memories for session context.`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.warn(`[memory-memplace] auto-recall failed (non-fatal): ${message}`);
    }
  }

  // ── Private Utilities ──────────────────────────────────────────────────────

  /**
   * Sends the transcript to the MemPlace diary_write MCP tool.
   * Called by handlePreCompact and optionally from external callers.
   */
  private async flushToDiary(transcript: string): Promise<void> {
    this.assertConnected();

    if (transcript.trim().length === 0) {
      this.ctx.logger.warn('[memory-memplace] flushToDiary called with empty transcript; skipping.');
      return;
    }

    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}]\n\n${transcript}`;

    const result = await this.mcpClient.callTool({
      name: 'diary_write',
      arguments: {
        content: entry,
        timestamp,
      },
    });

    const responseText = extractTextContent(result);
    this.ctx.logger.debug(`[memory-memplace] diary_write response: ${responseText}`);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error(
        '[memory-memplace] MCP client is not connected. Ensure activate() completed successfully before calling this method.'
      );
    }
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

/**
 * Default export: async factory function called by OpenClaw plugin loader.
 * Returns the activated MemPlacePlugin instance.
 */
export default async function createMemPlacePlugin(ctx: PluginContext): Promise<MemPlacePlugin> {
  const plugin = new MemPlacePlugin(ctx);
  await plugin.activate();
  return plugin;
}
