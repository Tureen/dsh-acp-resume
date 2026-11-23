import { inject } from 'vitest'

// Suppress ambient CLI discovery without changing plugin defaults under test.
// Use a real empty directory: an empty PATH entry can resolve against the cwd.
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete process.env[key]
}
process.env.PATH = inject('isolatedCliPath')
