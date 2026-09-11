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
import { ModelSelection, RuntimeMode, ProviderInteractionMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { randomUUID } from "./lib/utils";

export const QUEUED_MESSAGE_STORAGE_KEY = "t3code:queued-message:v1";

/** Matches the composer's own prompt ceiling closely enough to be no new limit. */
const MAX_QUEUED_PROMPT_CHARS = 100_000;

export const QueuedMessageSettings = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  text: Schema.String,
});
export type QueuedMessageSettings = typeof QueuedMessageSettings.Type;
const isQueuedMessageSettings = Schema.is(QueuedMessageSettings);

export interface QueuedMessage {
  readonly prompt: string;
  readonly queuedAt: string;
  readonly id: string;
  readonly sentAt?: string;
  readonly error?: string;
  readonly settings?: QueuedMessageSettings;
}

interface QueuedMessageStoreState {
  readonly byThreadKey: Readonly<Record<string, QueuedMessage>>;
  /** Queues or replaces a message unless delivery is pending. */
  readonly queue: (threadKey: string, prompt: string, settings?: QueuedMessageSettings) => boolean;
  /** Removes and returns an editable queued message. */
  readonly take: (threadKey: string) => QueuedMessage | null;
  readonly remove: (threadKey: string) => void;
  readonly beginSend: (threadKey: string, createdAt: string) => QueuedMessage | null;
  readonly failSend: (threadKey: string, id: string, error: string, rejected?: boolean) => void;
  readonly completeSend: (threadKey: string, id: string) => void;
  readonly retry: (threadKey: string) => void;
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
      const candidate = value as Partial<Record<keyof QueuedMessage, unknown>>;
      if (typeof candidate.prompt !== "string" || candidate.prompt.length === 0) continue;
      if (typeof candidate.queuedAt !== "string") continue;
      entries.push([
        threadKey,
        {
          prompt: candidate.prompt,
          queuedAt: candidate.queuedAt,
          id: typeof candidate.id === "string" ? candidate.id : randomUUID(),
          ...(typeof candidate.sentAt === "string" ? { sentAt: candidate.sentAt } : {}),
          ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
          ...(isQueuedMessageSettings(candidate.settings) ? { settings: candidate.settings } : {}),
        },
      ]);
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
  queue: (threadKey, prompt, settings) => {
    const existing = get().byThreadKey[threadKey];
    if (existing?.sentAt && !existing.error) return false;
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_QUEUED_PROMPT_CHARS) return false;
    const next = {
      ...get().byThreadKey,
      [threadKey]: {
        prompt: trimmed,
        queuedAt: new Date().toISOString(),
        id: randomUUID(),
        ...(settings ? { settings } : {}),
      },
    };
    set({ byThreadKey: next });
    persist(next);
    return true;
  },
  take: (threadKey) => {
    const existing = get().byThreadKey[threadKey];
    if (!existing || (existing.sentAt && !existing.error)) return null;
    const { [threadKey]: _removed, ...rest } = get().byThreadKey;
    set({ byThreadKey: rest });
    persist(rest);
    return existing;
  },
  beginSend: (threadKey, createdAt) => {
    const existing = get().byThreadKey[threadKey];
    if (!existing || existing.error) return null;
    const message = { ...existing, sentAt: existing.sentAt ?? createdAt };
    const next = { ...get().byThreadKey, [threadKey]: message };
    set({ byThreadKey: next });
    persist(next);
    return message;
  },
  failSend: (threadKey, id, error, rejected = false) => {
    const existing = get().byThreadKey[threadKey];
    if (existing?.id !== id) return;
    const { sentAt: _sentAt, ...unsent } = existing;
    const failed = rejected ? { ...unsent, id: randomUUID(), error } : { ...existing, error };
    const next = { ...get().byThreadKey, [threadKey]: failed };
    set({ byThreadKey: next });
    persist(next);
  },
  completeSend: (threadKey, id) => {
    if (get().byThreadKey[threadKey]?.id !== id) return;
    const { [threadKey]: _removed, ...rest } = get().byThreadKey;
    set({ byThreadKey: rest });
    persist(rest);
  },
  retry: (threadKey) => {
    const existing = get().byThreadKey[threadKey];
    if (!existing?.error) return;
    const { error: _error, ...message } = existing;
    const next = { ...get().byThreadKey, [threadKey]: message };
    set({ byThreadKey: next });
    persist(next);
  },
  remove: (threadKey) => {
    const existing = get().byThreadKey[threadKey];
    if (!existing || (existing.sentAt && !existing.error)) return;
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
