/**
 * One message per thread, held back until the agent finishes its turn.
 *
 * Sending mid-turn interrupts the agent; waiting means watching for the turn to
 * end. Queuing lets the next instruction be written the moment it is thought of
 * and delivered when the thread is actually ready for it.
 *
 * Text only, and deliberately one slot: a queue of many is a different feature,
 * and attachments belong to the composer draft that still holds them.
 *
 * @module queuedMessageStore
 */
import { create } from "zustand";

export const QUEUED_MESSAGE_STORAGE_KEY = "t3code:queued-message:v1";

/** Matches the composer's own prompt ceiling closely enough to be no new limit. */
const MAX_QUEUED_PROMPT_CHARS = 100_000;

export interface QueuedMessage {
  readonly prompt: string;
  readonly queuedAt: string;
}

interface QueuedMessageStoreState {
  readonly byThreadKey: Readonly<Record<string, QueuedMessage>>;
  /** Replaces any message already queued for the thread. */
  readonly queue: (threadKey: string, prompt: string) => boolean;
  /** Removes and returns the queued message, for sending or for editing. */
  readonly take: (threadKey: string) => QueuedMessage | null;
  readonly remove: (threadKey: string) => void;
}

/** The subset of `Storage` this module uses, so the fallback stays small. */
interface QueueStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function createMemoryStorage(): QueueStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

/**
 * Reading the `localStorage` property itself can throw when storage is blocked
 * by policy or the page is sandboxed, so the access is guarded rather than just
 * the calls on it. The in-memory fallback keeps the queue working for the
 * session; only surviving a reload is lost.
 */
function resolveStorage(): QueueStorage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Fall through to the in-memory store.
  }
  return createMemoryStorage();
}

const storage = resolveStorage();

function readStorage(): QueueStorage {
  return storage;
}

function readPersisted(): Record<string, QueuedMessage> {
  const storage = readStorage();
  try {
    const raw = storage.getItem(QUEUED_MESSAGE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries: Array<[string, QueuedMessage]> = [];
    for (const [threadKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const candidate = value as { prompt?: unknown; queuedAt?: unknown };
      if (typeof candidate.prompt !== "string" || candidate.prompt.length === 0) continue;
      if (typeof candidate.queuedAt !== "string") continue;
      entries.push([threadKey, { prompt: candidate.prompt, queuedAt: candidate.queuedAt }]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function persist(byThreadKey: Record<string, QueuedMessage>): void {
  const storage = readStorage();
  try {
    storage.setItem(QUEUED_MESSAGE_STORAGE_KEY, JSON.stringify(byThreadKey));
  } catch {
    // A full or blocked quota must not stop the message from being queued in
    // memory; it only means a reload will not find it.
  }
}

export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  byThreadKey: readPersisted(),
  queue: (threadKey, prompt) => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_QUEUED_PROMPT_CHARS) return false;
    const next = {
      ...get().byThreadKey,
      [threadKey]: { prompt: trimmed, queuedAt: new Date().toISOString() },
    };
    set({ byThreadKey: next });
    persist(next);
    return true;
  },
  take: (threadKey) => {
    const existing = get().byThreadKey[threadKey];
    if (!existing) return null;
    const { [threadKey]: _removed, ...rest } = get().byThreadKey;
    set({ byThreadKey: rest });
    persist(rest);
    return existing;
  },
  remove: (threadKey) => {
    if (!get().byThreadKey[threadKey]) return;
    const { [threadKey]: _removed, ...rest } = get().byThreadKey;
    set({ byThreadKey: rest });
    persist(rest);
  },
}));

/** Test seam: reads persisted state without needing a real `localStorage`. */
export function readQueuedMessageStorageForTest(): string | null {
  return readStorage().getItem(QUEUED_MESSAGE_STORAGE_KEY);
}

/** Test seam: replaces persisted state without needing a real `localStorage`. */
export function writeQueuedMessageStorageForTest(raw: string): void {
  readStorage().setItem(QUEUED_MESSAGE_STORAGE_KEY, raw);
  useQueuedMessageStore.setState({ byThreadKey: readPersisted() });
}
