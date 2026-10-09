import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // A hang detector, not a budget: tests touch the real filesystem.
    testTimeout: 20_000,
    // No test may depend on a neighbour's spies or stubbed env; shuffle probes
    // order-independence with a fresh seed on every run.
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    sequence: { shuffle: true },
  },
})
