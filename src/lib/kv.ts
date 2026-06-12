import Redis from "ioredis";

// ─── In-memory fallback (local dev without Redis) ────────────────────────────

type MemoryEntry = {
  value: unknown;
  expiresAt?: number;
};

const globalForMemory = globalThis as typeof globalThis & {
  __boomerDropKv?: Map<string, MemoryEntry>;
  __boomerDropKvTimers?: Map<string, ReturnType<typeof setTimeout>>;
};

const memoryStore =
  globalForMemory.__boomerDropKv ?? new Map<string, MemoryEntry>();
globalForMemory.__boomerDropKv = memoryStore;

const expiryTimers =
  globalForMemory.__boomerDropKvTimers ??
  new Map<string, ReturnType<typeof setTimeout>>();
globalForMemory.__boomerDropKvTimers = expiryTimers;

// ─── Redis client (production) ───────────────────────────────────────────────

// Reuse the connection across hot reloads / multiple invocations in the same
// process so we don't exhaust the Redis connection limit.
const globalForRedis = globalThis as typeof globalThis & {
  __boomerDropRedis?: Redis;
};

function getRedis(): Redis {
  if (!globalForRedis.__boomerDropRedis) {
    globalForRedis.__boomerDropRedis = new Redis(
      process.env.REDIS_URL as string,
      { maxRetriesPerRequest: 3, lazyConnect: false }
    );
  }
  return globalForRedis.__boomerDropRedis;
}

// ─── Mode detection ──────────────────────────────────────────────────────────

function isMemoryMode(): boolean {
  return !process.env.REDIS_URL;
}

// ─── Memory helpers ──────────────────────────────────────────────────────────

function purgeExpired(key: string): void {
  const entry = memoryStore.get(key);
  if (!entry?.expiresAt) return;
  if (Date.now() >= entry.expiresAt) {
    memoryStore.delete(key);
    const timer = expiryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      expiryTimers.delete(key);
    }
  }
}

function scheduleExpiry(key: string, seconds: number): void {
  const existing = expiryTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    memoryStore.delete(key);
    expiryTimers.delete(key);
  }, seconds * 1000);

  expiryTimers.set(key, timer);
}

function getMemoryList(key: string): string[] {
  purgeExpired(key);
  const entry = memoryStore.get(key);
  if (!entry) return [];
  return Array.isArray(entry.value) ? (entry.value as string[]) : [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function rpush(key: string, value: string): Promise<number> {
  if (isMemoryMode()) {
    const list = getMemoryList(key);
    list.push(value);
    memoryStore.set(key, {
      value: list,
      expiresAt: memoryStore.get(key)?.expiresAt,
    });
    return list.length;
  }
  return getRedis().rpush(key, value);
}

export async function lrange(
  key: string,
  start: number,
  end: number
): Promise<string[]> {
  if (isMemoryMode()) {
    const list = getMemoryList(key);
    const normalizedEnd = end < 0 ? list.length + end + 1 : end + 1;
    return list.slice(start, normalizedEnd);
  }
  return getRedis().lrange(key, start, end);
}

export async function expire(key: string, seconds: number): Promise<number> {
  if (isMemoryMode()) {
    const entry = memoryStore.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    memoryStore.set(key, entry);
    scheduleExpiry(key, seconds);
    return 1;
  }
  return getRedis().expire(key, seconds);
}

export async function set(
  key: string,
  value: string,
  options?: { ex?: number }
): Promise<void> {
  if (isMemoryMode()) {
    const expiresAt = options?.ex ? Date.now() + options.ex * 1000 : undefined;
    memoryStore.set(key, { value, expiresAt });
    if (options?.ex) scheduleExpiry(key, options.ex);
    return;
  }
  if (options?.ex) {
    await getRedis().set(key, value, "EX", options.ex);
    return;
  }
  await getRedis().set(key, value);
}

export async function get(key: string): Promise<string | null> {
  if (isMemoryMode()) {
    purgeExpired(key);
    const entry = memoryStore.get(key);
    if (!entry) return null;
    return typeof entry.value === "string" ? entry.value : null;
  }
  return getRedis().get(key);
}
