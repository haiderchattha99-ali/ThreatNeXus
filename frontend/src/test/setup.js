import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// globals:false in vite.config.js means RTL's own auto-cleanup (which relies
// on detecting a global afterEach) never registers, so each test's rendered
// tree would otherwise stack up in the DOM across a file's tests.
afterEach(() => {
  cleanup()
})

// Node's own built-in global `localStorage` (unconfigured, file-backed) can
// end up on window instead of jsdom's real Storage implementation depending
// on jsdom/Node version pairing, leaving a plain object with no
// clear()/getItem()/etc. Replace it with a minimal, real in-memory Storage
// so AuthContext's localStorage calls behave like they do in a browser,
// regardless of which one won the race.
class MemoryStorage {
  #store = new Map()

  getItem(key) {
    return this.#store.has(key) ? this.#store.get(key) : null
  }

  setItem(key, value) {
    this.#store.set(key, String(value))
  }

  removeItem(key) {
    this.#store.delete(key)
  }

  clear() {
    this.#store.clear()
  }
}

const memoryStorage = new MemoryStorage()
globalThis.localStorage = memoryStorage
if (typeof window !== 'undefined') {
  window.localStorage = memoryStorage
}
