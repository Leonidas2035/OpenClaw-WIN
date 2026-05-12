/**
 * gsd-bridge/src/index.ts
 *
 * OpenClaw native plugin — GSD Framework Execution Bridge.
 *
 * Architecture overview:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  .planning/STATE.md                                             │
 * │       │  (GSD task list)                                        │
 * │       ▼                                                          │
 * │  GsdBridgePlugin.syncGsdToQueue()  ◄── setInterval (10 min)    │
 * │       │                                                          │
 * │       ▼                                                          │
 * │  .openclaw/LOOP-QUEUE.md  ──────► RalphClaw execution loop     │
 * │                                                                  │
 * │  Slash-commands (chat:message)                                   │
 * │    /gsd-new-project ──► npx get-shit-done-cc /gsd-new-project  │
 * │                                                                  │
 * │  Tool: gsd_plan_phase  ──► npx get-shit-done-cc /gsd-plan-... │
 * │  Tool: gsd_execute_queue ──► dequeues first pending task        │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

// ─── SDK Interface Definitions ────────────────────────────────────────────────
// (mirrored from @openclaw/plugin-sdk as peer dep may not be installed in CI)

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): PluginLogger;
}

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

/** Validated config for this plugin (mirrors configSchema in openclaw.plugin.json) */
interface GsdBridgeConfig {
  projectRoot: string;
  syncIntervalMs?: number;
  gsdStatefile?: string;
  queueFile?: string;
  inboxFile?: string;
}

interface PluginContext {
  pluginId: string;
  config: GsdBridgeConfig;
  logger: PluginLogger;
  tools: ToolRegistry;
  events: PluginEventEmitter;
}

/** Shape of a chat message event emitted by OpenClaw */
interface ChatMessageEvent {
  text: string;
  channelId: string;
  userId: string;
  messageId: string;
}

function isChatMessageEvent(payload: unknown): payload is ChatMessageEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'text' in payload &&
    typeof (payload as Record<string, unknown>)['text'] === 'string'
  );
}

// ─── GSD task matching ────────────────────────────────────────────────────────

/**
 * Represents a parsed GSD task entry from STATE.md
 */
interface GsdTask {
  id: string;      // e.g. "GSD-TODO-abc123"
  label: string;   // Human-readable description
}

/** Regex pattern for GSD TODO items: "- [ ] GSD-TODO-<id>: <description>" */
const GSD_TODO_PATTERN = /^- \[ \] (GSD-TODO-[a-zA-Z0-9-]+): (.+)$/gm;

/** Regex to detect whether a GSD task ID already appears in LOOP-QUEUE.md */
function buildTaskPresenceRegex(taskId: string): RegExp {
  // Escape special regex chars in the task ID (hyphens are the only likely one here)
  const escaped = taskId.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  return new RegExp(escaped);
}

/** Parse all GSD-TODO tasks from the STATE.md content */
function parseGsdTasks(stateContent: string): GsdTask[] {
  const tasks: GsdTask[] = [];
  const pattern = new RegExp(GSD_TODO_PATTERN.source, 'gm');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stateContent)) !== null) {
    const id = match[1];
    const label = match[2];
    if (id !== undefined && label !== undefined) {
      tasks.push({ id: id.trim(), label: label.trim() });
    }
  }

  return tasks;
}

// ─── Subprocess execution helper ─────────────────────────────────────────────

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a command with spawn, collecting all stdout/stderr.
 * Returns a resolved promise with the output regardless of exit code.
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env as Record<string, string>,
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err: Error) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `Spawn error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
        exitCode: -1,
      });
    });

    child.on('close', (code: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}

// ─── LOOP-QUEUE.md helpers ───────────────────────────────────────────────────

const QUEUE_START_MARKER = '<!-- QUEUE_START -->';
const QUEUE_END_MARKER = '<!-- QUEUE_END -->';

/**
 * Reads the queue section between markers from the queue file content.
 * Returns the lines between markers (exclusive of the markers themselves).
 */
function extractQueueSection(content: string): string[] {
  const startIdx = content.indexOf(QUEUE_START_MARKER);
  const endIdx = content.indexOf(QUEUE_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    // Malformed file — return the whole content as queue lines
    return content.split('\n').filter((l) => l.trim().startsWith('- '));
  }

  const section = content.slice(startIdx + QUEUE_START_MARKER.length, endIdx);
  return section.split('\n').map((l) => l.trimEnd());
}

/**
 * Replaces the content between markers in the queue file with newLines.
 */
function replaceQueueSection(fileContent: string, newLines: string[]): string {
  const startIdx = fileContent.indexOf(QUEUE_START_MARKER);
  const endIdx = fileContent.indexOf(QUEUE_END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    // Append a new section at the end
    return (
      fileContent.trimEnd() +
      `\n\n${QUEUE_START_MARKER}\n${newLines.join('\n')}\n${QUEUE_END_MARKER}\n`
    );
  }

  const before = fileContent.slice(0, startIdx + QUEUE_START_MARKER.length);
  const after = fileContent.slice(endIdx);
  const body = newLines.length > 0 ? '\n' + newLines.join('\n') + '\n' : '\n';
  return before + body + after;
}

// ─── Main plugin class ────────────────────────────────────────────────────────

class GsdBridgePlugin {
  private readonly ctx: PluginContext;

  /** Absolute path to the .planning/ directory */
  private readonly planningDir: string;

  /** Absolute path to STATE.md inside .planning/ */
  private readonly stateFilePath: string;

  /** Absolute path to LOOP-QUEUE.md */
  private readonly loopQueuePath: string;

  /** Absolute path to LOOP-INBOX.md */
  private readonly loopInboxPath: string;

  /** setInterval handle for the sync loop */
  private syncIntervalHandle: NodeJS.Timeout | null = null;

  /** Bound event handler reference for chat:message */
  private readonly onChatMessage: (payload: unknown) => Promise<void>;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;

    const projectRoot = ctx.config.projectRoot;
    const statefile = ctx.config.gsdStatefile ?? 'STATE.md';
    const queueRelPath = ctx.config.queueFile ?? '.openclaw/LOOP-QUEUE.md';
    const inboxRelPath = ctx.config.inboxFile ?? '.openclaw/LOOP-INBOX.md';

    this.planningDir = path.join(projectRoot, '.planning');
    this.stateFilePath = path.join(this.planningDir, statefile);
    this.loopQueuePath = path.join(projectRoot, queueRelPath);
    this.loopInboxPath = path.join(projectRoot, inboxRelPath);

    this.onChatMessage = this.handleChatMessage.bind(this);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async activate(): Promise<void> {
    this.ctx.logger.info(`[gsd-bridge] Activating. projectRoot: ${this.ctx.config.projectRoot}`);
    this.ctx.logger.info(`[gsd-bridge] planningDir: ${this.planningDir}`);
    this.ctx.logger.info(`[gsd-bridge] loopQueuePath: ${this.loopQueuePath}`);

    // Ensure required directories and files exist
    this.ensureFileSystemStructure();

    // Register GSD tools
    this.registerTools();

    // Subscribe to chat messages for slash commands
    this.ctx.events.on('chat:message', this.onChatMessage);

    // Run an initial sync immediately, then schedule at interval
    const syncIntervalMs = this.ctx.config.syncIntervalMs ?? 600000;
    this.ctx.logger.info(`[gsd-bridge] Starting sync loop (interval: ${syncIntervalMs}ms)`);

    try {
      await this.syncGsdToQueue();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal on activation — STATE.md may not exist yet at first run
      this.ctx.logger.warn(`[gsd-bridge] Initial sync failed (non-fatal): ${message}`);
    }

    this.syncIntervalHandle = setInterval(async () => {
      try {
        await this.syncGsdToQueue();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.logger.error(`[gsd-bridge] Periodic sync failed: ${message}`);
      }
    }, syncIntervalMs);

    this.ctx.logger.info('[gsd-bridge] Plugin activated successfully.');
  }

  async deactivate(): Promise<void> {
    this.ctx.logger.info('[gsd-bridge] Deactivating...');

    if (this.syncIntervalHandle !== null) {
      clearInterval(this.syncIntervalHandle);
      this.syncIntervalHandle = null;
    }

    this.ctx.events.off('chat:message', this.onChatMessage);
    this.ctx.logger.info('[gsd-bridge] Plugin deactivated.');
  }

  // ── File System Bootstrap ─────────────────────────────────────────────────

  private ensureFileSystemStructure(): void {
    // .planning/ directory
    if (!existsSync(this.planningDir)) {
      mkdirSync(this.planningDir, { recursive: true });
      this.ctx.logger.info(`[gsd-bridge] Created directory: ${this.planningDir}`);
    }

    // Parent dir of queue / inbox
    const queueDir = path.dirname(this.loopQueuePath);
    if (!existsSync(queueDir)) {
      mkdirSync(queueDir, { recursive: true });
      this.ctx.logger.info(`[gsd-bridge] Created directory: ${queueDir}`);
    }

    // LOOP-QUEUE.md
    if (!existsSync(this.loopQueuePath)) {
      const queueContent = [
        '# LOOP-QUEUE.md — RalphClaw Execution Queue',
        '',
        '> Auto-managed by gsd-bridge plugin. Do not edit manually during active sessions.',
        '> Format: `- [ ] GSD-TODO-<id>: <description>`',
        '',
        QUEUE_START_MARKER,
        QUEUE_END_MARKER,
        '',
      ].join('\n');
      writeFileSync(this.loopQueuePath, queueContent, 'utf8');
      this.ctx.logger.info(`[gsd-bridge] Created: ${this.loopQueuePath}`);
    }

    // LOOP-INBOX.md
    if (!existsSync(this.loopInboxPath)) {
      const inboxContent = [
        '# LOOP-INBOX.md — Incoming Task Inbox',
        '',
        '> Tasks captured here are awaiting triage into LOOP-QUEUE.md.',
        '',
        '<!-- INBOX_START -->',
        '<!-- INBOX_END -->',
        '',
      ].join('\n');
      writeFileSync(this.loopInboxPath, inboxContent, 'utf8');
      this.ctx.logger.info(`[gsd-bridge] Created: ${this.loopInboxPath}`);
    }
  }

  // ── Core Bridge Logic ─────────────────────────────────────────────────────

  /**
   * Reads .planning/STATE.md, extracts GSD-TODO tasks, and idempotently
   * appends any new ones to LOOP-QUEUE.md.
   *
   * Idempotency guarantee: a task is only added if its ID does not already
   * appear anywhere in the current queue file content.
   */
  async syncGsdToQueue(): Promise<void> {
    this.ctx.logger.debug('[gsd-bridge] syncGsdToQueue() — starting sync cycle');

    // 1. Read STATE.md
    if (!existsSync(this.stateFilePath)) {
      this.ctx.logger.debug(
        `[gsd-bridge] STATE.md not found at ${this.stateFilePath} — nothing to sync.`
      );
      return;
    }

    let stateContent: string;
    try {
      stateContent = readFileSync(this.stateFilePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read STATE.md: ${message}`);
    }

    // 2. Parse GSD TODO tasks
    const tasks = parseGsdTasks(stateContent);
    if (tasks.length === 0) {
      this.ctx.logger.debug('[gsd-bridge] No GSD-TODO items found in STATE.md.');
      return;
    }

    this.ctx.logger.info(`[gsd-bridge] Found ${tasks.length} GSD-TODO item(s) in STATE.md.`);

    // 3. Read current LOOP-QUEUE.md
    let queueContent: string;
    try {
      queueContent = readFileSync(this.loopQueuePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read LOOP-QUEUE.md: ${message}`);
    }

    const queueLines = extractQueueSection(queueContent);
    let modified = false;
    let addedCount = 0;

    // 4. For each task, check idempotency and append if missing
    for (const task of tasks) {
      const presenceRegex = buildTaskPresenceRegex(task.id);

      if (presenceRegex.test(queueContent)) {
        this.ctx.logger.debug(`[gsd-bridge] Task already queued — skipping: ${task.id}`);
        continue;
      }

      // New task — add to queue
      const newLine = `- [ ] ${task.id}: ${task.label}`;
      queueLines.push(newLine);
      modified = true;
      addedCount++;
      this.ctx.logger.info(`[gsd-bridge] Enqueued new task: ${newLine}`);
    }

    // 5. Write updated queue back to disk (only if modified)
    if (modified) {
      // Filter out empty leading/trailing lines within the section, but keep others
      const cleanedLines = queueLines.filter((l) => l !== undefined);
      const updatedContent = replaceQueueSection(queueContent, cleanedLines);

      try {
        writeFileSync(this.loopQueuePath, updatedContent, 'utf8');
        this.ctx.logger.info(
          `[gsd-bridge] LOOP-QUEUE.md updated — ${addedCount} new task(s) added.`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write LOOP-QUEUE.md: ${message}`);
      }
    } else {
      this.ctx.logger.debug('[gsd-bridge] Queue is already up-to-date — no changes written.');
    }
  }

  // ── Tool Registration ─────────────────────────────────────────────────────

  private registerTools(): void {
    const logger = this.ctx.logger.child({ component: 'tools' });

    // ── Tool: gsd_plan_phase ─────────────────────────────────────────────────
    this.ctx.tools.register<{ phase_num: number }>({
      name: 'gsd_plan_phase',
      description:
        'Run the GSD plan-phase command for a given phase number. This invokes `npx get-shit-done-cc /gsd-plan-phase <N>` in the project root and returns the combined stdout/stderr output.',
      inputSchema: {
        type: 'object',
        properties: {
          phase_num: {
            type: 'number',
            description: 'The GSD phase number to plan (e.g. 1, 2, 3...).',
          },
        },
        required: ['phase_num'],
      },
      handler: async (input) => {
        const phaseNum = Math.floor(input.phase_num);
        if (phaseNum < 1) {
          return { content: 'Error: phase_num must be a positive integer.', isError: true };
        }

        const phaseArg = `/gsd-plan-phase ${phaseNum}`;
        logger.info(`gsd_plan_phase: running npx get-shit-done-cc "${phaseArg}" in ${this.ctx.config.projectRoot}`);

        let result: SpawnResult;
        try {
          result = await runCommand(
            'npx',
            ['get-shit-done-cc', phaseArg],
            this.ctx.config.projectRoot
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`gsd_plan_phase spawn error: ${message}`);
          return { content: `Failed to spawn GSD process: ${message}`, isError: true };
        }

        const output = [
          `## GSD Plan Phase ${phaseNum}`,
          `**Exit code:** ${result.exitCode}`,
          '',
          result.stdout.trim().length > 0
            ? `### stdout\n\`\`\`\n${result.stdout.trim()}\n\`\`\``
            : '*(no stdout)*',
          '',
          result.stderr.trim().length > 0
            ? `### stderr\n\`\`\`\n${result.stderr.trim()}\n\`\`\``
            : '*(no stderr)*',
        ].join('\n');

        return {
          content: output,
          isError: result.exitCode !== 0,
        };
      },
    });

    // ── Tool: gsd_execute_queue ──────────────────────────────────────────────
    this.ctx.tools.register<Record<string, never>>({
      name: 'gsd_execute_queue',
      description:
        'Read LOOP-QUEUE.md and return the first pending task (marked `- [ ]`) to the agent with a directive to execute it. Returns a structured response indicating which task to work on next.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async (_input) => {
        logger.info('gsd_execute_queue: reading LOOP-QUEUE.md for next task');

        if (!existsSync(this.loopQueuePath)) {
          return {
            content: 'LOOP-QUEUE.md does not exist. Run a sync first or ensure gsd-bridge is activated.',
            isError: true,
          };
        }

        let queueContent: string;
        try {
          queueContent = readFileSync(this.loopQueuePath, 'utf8');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`gsd_execute_queue read error: ${message}`);
          return { content: `Failed to read LOOP-QUEUE.md: ${message}`, isError: true };
        }

        const queueLines = extractQueueSection(queueContent);

        // Find the first unchecked item
        const pendingLine = queueLines.find((line) => /^- \[ \]/.test(line.trim()));

        if (pendingLine === undefined) {
          return {
            content:
              '✅ Queue is empty — no pending tasks found in LOOP-QUEUE.md.\n\nAll tasks have been completed or the queue has not been synced yet.',
          };
        }

        // Parse task ID and label from the line
        const taskMatch = pendingLine.match(/^- \[ \] (GSD-TODO-[a-zA-Z0-9-]+): (.+)$/);
        const taskId = taskMatch?.[1] ?? 'UNKNOWN';
        const taskLabel = taskMatch?.[2] ?? pendingLine.replace(/^- \[ \] /, '');

        return {
          content: [
            `## 🎯 Next Task to Execute`,
            '',
            `**Task ID:** \`${taskId}\``,
            `**Description:** ${taskLabel}`,
            '',
            '### Execution Protocol',
            '1. Read `.planning/PLAN.md` and `.planning/CONTEXT.md` for full task context.',
            '2. Write failing tests first (Nyquist Layer requirement).',
            '3. Implement the logic to make tests pass.',
            '4. Run lint and type-check before marking complete.',
            '5. After completion, update this task in LOOP-QUEUE.md: change `- [ ]` to `- [x]`.',
            '',
            `> **Proceed to implement task \`${taskId}\` now.**`,
          ].join('\n'),
        };
      },
    });

    logger.info('[gsd-bridge] Registered 2 tools: gsd_plan_phase, gsd_execute_queue');
  }

  // ── Event Handlers ────────────────────────────────────────────────────────

  private async handleChatMessage(payload: unknown): Promise<void> {
    if (!isChatMessageEvent(payload)) {
      return;
    }

    const text = payload.text.trim();

    // ── Slash command: /gsd-new-project ──────────────────────────────────────
    if (text === '/gsd-new-project') {
      this.ctx.logger.info('[gsd-bridge] /gsd-new-project slash command received.');
      await this.executeGsdNewProject(payload.channelId);
      return;
    }

    // ── Slash command: /gsd-sync ─────────────────────────────────────────────
    if (text === '/gsd-sync') {
      this.ctx.logger.info('[gsd-bridge] /gsd-sync slash command received.');
      try {
        await this.syncGsdToQueue();
        this.ctx.logger.info('[gsd-bridge] Manual sync triggered by /gsd-sync completed.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.logger.error(`[gsd-bridge] /gsd-sync failed: ${message}`);
      }
      return;
    }

    // ── Slash command: /gsd-status ────────────────────────────────────────────
    if (text === '/gsd-status') {
      this.ctx.logger.info('[gsd-bridge] /gsd-status slash command received.');
      this.logQueueStatus();
      return;
    }
  }

  /**
   * Runs `npx get-shit-done-cc /gsd-new-project` in the project root.
   * Logs the output and confirms artifact generation to the user context.
   */
  private async executeGsdNewProject(_channelId: string): Promise<void> {
    this.ctx.logger.info(
      `[gsd-bridge] Running: npx get-shit-done-cc /gsd-new-project in ${this.ctx.config.projectRoot}`
    );

    let result: SpawnResult;
    try {
      result = await runCommand(
        'npx',
        ['get-shit-done-cc', '/gsd-new-project'],
        this.ctx.config.projectRoot
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`[gsd-bridge] /gsd-new-project spawn failed: ${message}`);
      return;
    }

    if (result.exitCode === 0) {
      this.ctx.logger.info(
        '[gsd-bridge] /gsd-new-project completed successfully. GSD project artifacts generated.'
      );
      this.ctx.logger.info(`[gsd-bridge] stdout: ${result.stdout.slice(0, 500)}`);
    } else {
      this.ctx.logger.error(
        `[gsd-bridge] /gsd-new-project exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`
      );
    }
  }

  /**
   * Logs a summary of the current queue status to the plugin logger.
   */
  private logQueueStatus(): void {
    if (!existsSync(this.loopQueuePath)) {
      this.ctx.logger.warn('[gsd-bridge] /gsd-status: LOOP-QUEUE.md not found.');
      return;
    }

    try {
      const content = readFileSync(this.loopQueuePath, 'utf8');
      const lines = extractQueueSection(content);
      const pending = lines.filter((l) => /^- \[ \]/.test(l.trim())).length;
      const done = lines.filter((l) => /^- \[x\]/.test(l.trim())).length;
      const inProgress = lines.filter((l) => /^- \[\/\]/.test(l.trim())).length;
      const total = pending + done + inProgress;

      this.ctx.logger.info(
        `[gsd-bridge] Queue status — Total: ${total} | Pending: ${pending} | In-progress: ${inProgress} | Done: ${done}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`[gsd-bridge] /gsd-status read error: ${message}`);
    }
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

/**
 * Default export: async factory function called by OpenClaw plugin loader.
 */
export default async function createGsdBridgePlugin(ctx: PluginContext): Promise<GsdBridgePlugin> {
  const plugin = new GsdBridgePlugin(ctx);
  await plugin.activate();
  return plugin;
}
