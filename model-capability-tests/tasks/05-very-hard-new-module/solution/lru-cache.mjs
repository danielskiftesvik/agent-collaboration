export class LRUCache {
  #capacity;
  #map;

  constructor(capacity) {
    if (capacity <= 0) throw new Error("capacity must be positive");
    this.#capacity = capacity;
    this.#map = new Map();
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#capacity) {
      const lruKey = this.#map.keys().next().value;
      this.#map.delete(lruKey);
    }
    this.#map.set(key, value);
  }

  has(key) {
    return this.#map.has(key);
  }

  get size() {
    return this.#map.size;
  }
}
