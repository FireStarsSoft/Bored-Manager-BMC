/**
 * The wiring layer: the only folder that is allowed to know every domain
 * exists. Nothing under `ipmi/`, `store/`, `sweep/` or `machines/` may import
 * this folder back. Import this barrel, never a file inside it.
 */
export * from './readiness'
export * from './container'
export * from './handlers'
