import type { OpenAIMessage } from "./types";
import { formatThinking } from "./upstream";

interface CachedTurn {
  reasoning: string;
  answer: string;
}

export interface AugmentOpts {
  /** When false, no cached reasoning is injected. */
  enabled?: boolean;
  /** Scopes keys per conversation so reasoning cannot leak across sessions. */
  sessionId?: string;
}

const MAX_TURNS = 200;

/**
 * Remembers the thinking (reasoning_content) produced for each turn, keyed by
 * the message context that preceded it, and re-injects it into later requests
 * so the model keeps its reasoning across messages. In-memory only: reasoning
 * does not need to survive a restart.
 */
export class ThinkingCache {
  private turns = new Map<string, CachedTurn>();
  private order: string[] = [];

  private static key(messages: OpenAIMessage[], sessionId?: string): string {
    const prefix = sessionId ? `${sessionId}\u0000` : "";
    return (
      prefix + JSON.stringify(messages.map((m) => [m.role, m.content ?? ""]))
    );
  }

  remember(
    messages: OpenAIMessage[],
    reasoning: string,
    answer: string,
    sessionId?: string,
  ) {
    if (!reasoning.trim()) return;
    const key = ThinkingCache.key(messages, sessionId);
    this.turns.set(key, { reasoning, answer });
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    // ponytail: fixed-size FIFO eviction instead of a TTL; threads nothing
    while (this.order.length > MAX_TURNS) {
      const oldest = this.order.shift();
      if (oldest) this.turns.delete(oldest);
    }
  }

  /**
   * Re-inject cached thinking into assistant turns whose context we recognize,
   * and insert a synthetic assistant turn when the client dropped an
   * interrupted reply entirely (consecutive user messages).
   */
  augment(messages: OpenAIMessage[], opts: AugmentOpts = {}): OpenAIMessage[] {
    if (opts.enabled === false) return messages;
    const sessionId = opts.sessionId;
    const out: OpenAIMessage[] = [];
    messages.forEach((m, i) => {
      if (m.role === "assistant") {
        const turn = this.turns.get(
          ThinkingCache.key(messages.slice(0, i), sessionId),
        );
        out.push(
          turn
            ? {
                ...m,
                content: formatThinking(
                  turn.reasoning,
                  m.content || turn.answer,
                ),
              }
            : m,
        );
        return;
      }
      if (i > 0 && messages[i - 1]?.role === "user") {
        // The reply that separated these two user messages was dropped.
        const turn = this.turns.get(
          ThinkingCache.key(messages.slice(0, i), sessionId),
        );
        if (turn) {
          out.push({
            role: "assistant",
            content: formatThinking(turn.reasoning, turn.answer),
          });
        }
      }
      out.push(m);
    });
    return out;
  }
}
