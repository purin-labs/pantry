/**
 * Interrupt polls one execution may use. QuickJS made about 10,000 polls for
 * each second of computation in a Cloudflare Durable Object (upstream
 * measurement, October 2026), so this value approximates the five-second
 * computation ceiling of Code Mode. The caller may only ask for less.
 */
export const CODE_MODE_SANDBOX_INTERRUPT_BUDGET = 50_000;
export const CODE_MODE_SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
