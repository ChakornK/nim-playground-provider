import type { OpenAIMessage } from "./types";

interface CachedTurn {
  reasoning: string;
  answer: string;
}

const MAX_TURNS = 200;

/**
 * Remembers the thinking (reasoning_content) produced for each completed turn,
 * keyed by the full message context that preceded it, and re-injects it into
 * later requests as ` thinking ...\n response ...` so the model keeps its
 * reasoning even when the client dropped it or the turn was interrupted.
 */
export class ThinkingCache {
  private turns = new Map<string, CachedTurn>();
  private order: string[] = [];

  private static key(messages: OpenAIMessage[]): string {
    return JSON.stringify(messages.map((m) => [m.role, m.content ?? ""]));
  }

  remember(messages: OpenAIMessage[], reasoning: string, answer: string) {
    if (!reasoning.trim()) return;
    const key = ThinkingCache.key(messages);
    this.turns.set(key, { reasoning, answer });
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    // ponytail: fixed-size FIFO eviction instead of a TTL; threads nothing
    while (this.order.length > MAX_TURNS) {
      const oldest = this.order.shift();
      if (oldest) this.turns.delete(oldest);
    }
  }

  /** Re-inject cached thinking into assistant turns whose history we recognize. */
  augment(messages: OpenAIMessage[]): OpenAIMessage[] {
    return messages.map((m, i) => {
      if (m.role !== "assistant") return m;
      const turn = this.turns.get(ThinkingCache.key(messages.slice(0, i)));
      if (!turn) return m;
      return {
        ...m,
        content: ` thinking\n${turn.reasoning}\n response\n${m.content ?? turn.answer}`,
      };
    });
  }
}
