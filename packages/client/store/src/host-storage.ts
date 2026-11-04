/** String storage used by the Client's persisted view state. */
export interface HostStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Resolve a storage backend for one Client feature.
 * @param storage - explicit Host storage, or absence for ordinary browser storage.
 * @returns the selected storage, or absence when browser storage is unavailable.
 */
export function resolveHostStorage(storage?: HostStorage): HostStorage | undefined {
  if (storage !== undefined) return storage
  try {
    return globalThis.localStorage
  } catch (_storageUnavailable) {
    return undefined
  }
}

/**
 * Allocate an isolated backend whose records live with the Client runtime.
 * @returns empty storage that never reads or writes browser storage.
 */
export function createMemoryHostStorage(): HostStorage {
  const items = new Map<string, string>()
  let keys: readonly string[] | undefined
  return {
    get length() { return items.size },
    key: index => (keys ??= [...items.keys()])[index] ?? null,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      if (!items.has(key)) keys = undefined
      items.set(key, value)
    },
    removeItem: (key) => {
      if (items.delete(key)) keys = undefined
    },
  }
}
