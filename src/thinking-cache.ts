import { readFileSync, writeFileSync } from "node:fs";
import type { OpenAIMessage } from "./types";

interface CachedTurn {
  reasoning: string;
  answer: string;
}

const MAX_TURNS = 200;

const format = (turn: CachedTurn, answer: string) =>
  ` thinking\n${turn.reasoning}\n response\n${answer || turn.answer}`;

/**
 * Remembers the thinking (reasoning_content) produced for each turn, keyed by
 * the message context that preceded it, and re-injects it into later requests
 * as ` thinking ...\n response ...` so the model keeps its reasoning even when
 * the client dropped it or the turn was interrupted.
 */
export class ThinkingCache {
  private turns = new Map<string, CachedTurn>();
  private order: string[] = [];
  private file?: string;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as {
          order: string[];
          turns: Record<string, CachedTurn>;
        };
        this.order = raw.order ?? [];
        this.turns = new Map(Object.entries(raw.turns ?? {}));
      } catch {
        // missing or unreadable file starts empty; best-effort persistence
      }
    }
  }

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
    this.scheduleSave();
  }

  /**
   * Re-inject cached thinking into assistant turns whose context we recognize,
   * and insert a synthetic assistant turn when the client dropped an
   * interrupted reply entirely (consecutive user messages).
   */
  augment(messages: OpenAIMessage[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = [];
    messages.forEach((m, i) => {
      if (m.role === "assistant") {
        const turn = this.turns.get(ThinkingCache.key(messages.slice(0, i)));
        out.push(turn ? { ...m, content: format(turn, m.content ?? "") } : m);
        return;
      }
      if (i > 0 && messages[i - 1]?.role === "user") {
        // The reply that separated these two user messages was dropped.
        const turn = this.turns.get(ThinkingCache.key(messages.slice(0, i)));
        if (turn) {
          out.push({ role: "assistant", content: format(turn, turn.answer) });
        }
      }
      out.push(m);
    });
    return out;
  }

  /** Write cached turns to disk synchronously; also clears the pending save. */
  flush() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    try {
      writeFileSync(
        this.file,
        JSON.stringify({
          order: this.order,
          turns: Object.fromEntries(this.turns),
        }),
      );
    } catch {
      // best-effort; a failed write should not break requests
    }
  }

  private scheduleSave() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    // ponytail: debounced full-file write; a per-entry log is overkill here
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }
}
