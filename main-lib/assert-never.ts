// Node-side twin of src/lib/assertNever.ts — exhaustiveness guard for
// discriminated-union dispatch (worker message protocols, Tier 4 seams).
// Call it in the default / trailing branch of a dispatch over a union:
// a new variant turns every unhandled call site into a type error, and at
// runtime an unexpected value throws instead of being silently ignored.
export function assertNever(value: never): never {
	throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
