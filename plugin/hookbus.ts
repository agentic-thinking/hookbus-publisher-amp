// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
/**
 * HookBus publisher plugin for Sourcegraph Amp.
 *
 * Publishes all 5 Amp lifecycle events (session.start, agent.start, tool.call,
 * tool.result, agent.end) to a HookBus endpoint and translates the consolidated
 * bus verdict back into Amp's plugin API response shape.
 *
 * Install: drop this file at ~/.config/amp/plugins/hookbus.ts
 * Launch:  amp-hookbus           (wrapper, installed alongside the plugin)
 *          or:  PLUGINS=all amp  (inline, no shell profile pollution)
 *
 * Config resolution order (v0.2.2):
 *   1. process.env.HOOKBUS_*  (inline override, highest priority)
 *   2. ~/.config/amp/plugins/hookbus.env  (per-publisher dotenv, mode 600)
 *   3. Documented defaults (below)
 *
 * This plugin NEVER reads from ~/.bashrc. The installer writes the config
 * file in (2) and creates the amp-hookbus wrapper. Shell profiles remain
 * untouched so sibling publishers (Cursor, Claude Code, Hermes) keep their
 * own event source labels and bus URLs clean.
 *
 * Env vars (also accepted as keys in hookbus.env):
 *   HOOKBUS_URL         (default http://localhost:18800/event)
 *   HOOKBUS_TOKEN       (bearer token, required if bus auth enabled)
 *   HOOKBUS_SOURCE      (default "amp")
 *   HOOKBUS_TIMEOUT_MS  (default 30000)
 *   HOOKBUS_FAIL_MODE   ("open" or "closed", default "open")
 *   HOOKBUS_DEBUG       (set to "1" to emit diagnostic logs on stderr)
 *
 * Licence: MIT. Copyright 2026 Agentic Thinking Limited.
 */
import type { PluginAPI } from '@ampcode/plugin';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const VERSION = '0.2.2';

function loadEnvFile(p: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
    return out;
  } catch (_) {
    return {};
  }
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'amp', 'plugins', 'hookbus.env');
const FILE_ENV = loadEnvFile(CONFIG_PATH);
const cfg = (k: string, d: string) => process.env[k] ?? FILE_ENV[k] ?? d;

const BUS_URL = cfg('HOOKBUS_URL', 'http://localhost:18800/event');
const TOKEN = cfg('HOOKBUS_TOKEN', '');
const SOURCE = cfg('HOOKBUS_SOURCE', 'amp');
const TIMEOUT_MS = parseInt(cfg('HOOKBUS_TIMEOUT_MS', '30000'), 10);
const FAIL_MODE_RAW = cfg('HOOKBUS_FAIL_MODE', 'open').toLowerCase();
const FAIL_MODE: 'open' | 'closed' = FAIL_MODE_RAW === 'closed' ? 'closed' : 'open';
const DEBUG = cfg('HOOKBUS_DEBUG', '') === '1';

function log(level: 'info' | 'warn' | 'error', msg: string) {
  if (!DEBUG && level === 'info') return;
  process.stderr.write(`[hookbus-amp] ${level}: ${msg}\n`);
}

// Startup validation: fail fast on obviously-broken config.
try {
  const parsed = new URL(BUS_URL);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log('error', `HOOKBUS_URL has unsupported protocol "${parsed.protocol}", only http/https allowed. All events will fail.`);
  }
} catch (e) {
  log('error', `HOOKBUS_URL is not a valid URL (${BUS_URL}). All events will fail.`);
}
if (!TOKEN) log('warn', 'HOOKBUS_TOKEN is empty. Requests will be rejected by an authenticated bus.');
log('info', `started v${VERSION} (source=${SOURCE}, fail_mode=${FAIL_MODE}, bus=${BUS_URL}, config=${Object.keys(FILE_ENV).length > 0 ? CONFIG_PATH : 'env only'})`);

type Verdict = {
  decision?: string;
  reason?: string;
  context?: string;
};

function sessionIdFor(event: unknown): string {
  // Concurrent-safe: derive from the event itself, no shared module state.
  // session.start and tool.call carry thread.id per the Amp plugin API;
  // agent.start, agent.end, tool.result don't, so we fall back to the plugin
  // process id. Enables per-process correlation even in multi-thread sessions.
  const e = event as { thread?: { id?: string }; threadId?: string } | null | undefined;
  return e?.thread?.id || e?.threadId || `amp-pid-${process.pid}`;
}

function buildEnvelope(
  eventType: string,
  opts: {
    sessionId: string;
    toolName?: string;
    toolInput?: unknown;
    metadata?: Record<string, unknown>;
  }
) {
  const input = opts.toolInput;
  const tool_input =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : { value: input };
  return {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    source: SOURCE,
    session_id: opts.sessionId,
    tool_name: opts.toolName || '',
    tool_input,
    metadata: {
      publisher: 'hookbus-amp-publisher',
      publisher_version: VERSION,
      ...(opts.metadata || {}),
    },
  };
}

async function postEvent(envelope: ReturnType<typeof buildEnvelope>): Promise<Verdict> {
  const failback: Verdict = {
    decision: FAIL_MODE === 'closed' ? 'deny' : 'allow',
    reason: 'HookBus unreachable',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let body: string;
  try {
    body = JSON.stringify(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `envelope serialisation failed (${msg}), falling back to ${failback.decision}`);
    clearTimeout(timer);
    return { ...failback, reason: `envelope serialisation failed: ${msg}` };
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const res = await fetch(BUS_URL, { method: 'POST', headers, body, signal: controller.signal });

    if (!res.ok) {
      log('warn', `bus returned HTTP ${res.status} for ${envelope.event_type}`);
      return { ...failback, reason: `HookBus HTTP ${res.status}` };
    }

    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
      log('warn', `bus returned non-JSON content-type "${ctype}" for ${envelope.event_type}`);
      return { ...failback, reason: `HookBus returned non-JSON (${ctype || 'unknown'})` };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warn', `bus response JSON parse failed (${msg}) for ${envelope.event_type}`);
      return { ...failback, reason: `HookBus response not valid JSON: ${msg}` };
    }

    if (!parsed || typeof parsed !== 'object') {
      log('warn', `bus response not an object for ${envelope.event_type}`);
      return { ...failback, reason: 'HookBus response was not an object' };
    }

    return parsed as Verdict;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `bus unreachable (${msg}) for ${envelope.event_type}, failing ${FAIL_MODE}`);
    return { ...failback, reason: `HookBus unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export default function register(amp: PluginAPI) {
  amp.on('session.start', async (event: any) => {
    const sessionId = sessionIdFor(event);
    await postEvent(buildEnvelope('SessionStart', { sessionId }));
  });

  amp.on('agent.start', async (event: any) => {
    const sessionId = sessionIdFor(event);
    const verdict = await postEvent(
      buildEnvelope('UserPromptSubmit', {
        sessionId,
        toolInput: { prompt: event?.message, id: event?.id },
        metadata: { prompt_id: event?.id },
      })
    );
    const decision = (verdict.decision || 'allow').toLowerCase();
    if (decision === 'deny') {
      // No hard-block for agent.start in the plugin API contract.
      // Surface the reason as an injected context message so the user sees why.
      return { message: { content: `[HookBus blocked prompt] ${verdict.reason || ''}`, display: true } };
    }
    // Match claude-code-gate pattern: inject reason as context on allow
    // (strip leading [cre] prefix to match existing behaviour).
    let context = verdict.context || verdict.reason || '';
    if (context.startsWith('[cre] ')) context = context.slice(6);
    if (context.trim()) {
      return { message: { content: context, display: true } };
    }
    return;
  });

  amp.on('tool.call', async (event: any) => {
    const sessionId = sessionIdFor(event);
    const verdict = await postEvent(
      buildEnvelope('PreToolUse', {
        sessionId,
        toolName: event?.tool,
        toolInput: event?.input,
        metadata: { tool_use_id: event?.toolUseID },
      })
    );
    const decision = (verdict.decision || 'allow').toLowerCase();
    if (decision === 'deny') {
      return { action: 'reject-and-continue', message: verdict.reason || 'HookBus denied' };
    }
    if (decision === 'ask') {
      return {
        action: 'reject-and-continue',
        message: (verdict.reason || 'HookBus approval required') + ' (resubmit to proceed)',
      };
    }
    if (decision !== 'allow') {
      log('warn', `unknown verdict decision "${decision}" for PreToolUse, defaulting to allow`);
    }
    return { action: 'allow' };
  });

  amp.on('tool.result', async (event: any) => {
    const sessionId = sessionIdFor(event);
    await postEvent(
      buildEnvelope('PostToolUse', {
        sessionId,
        toolName: event?.tool,
        toolInput: event?.input,
        metadata: {
          tool_use_id: event?.toolUseID,
          status: event?.status,
          error: event?.error,
          output_preview: typeof event?.output === 'string' ? event.output.slice(0, 2000) : undefined,
        },
      })
    );
  });

  amp.on('agent.end', async (event: any) => {
    const sessionId = sessionIdFor(event);
    await postEvent(
      buildEnvelope('Stop', {
        sessionId,
        metadata: {
          prompt_id: event?.id,
          status: event?.status,
          message_count: Array.isArray(event?.messages) ? event.messages.length : undefined,
        },
      })
    );
  });
}
