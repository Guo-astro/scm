/**
 * Exhaustiveness guard for discriminated-union switches — the "PS-lite"
 * stand-in for PureScript's compiler-enforced total matching.
 *
 * Use as the `default` arm of a switch whose cases are typed `never` when
 * every variant is handled:
 *
 * ```ts
 * switch (view) {
 *   case "all-files": ...; break;
 *   // ...
 *   default:
 *     assertNever(view); // TS error here the moment ViewId gains a variant
 * }
 * ```
 *
 * Rule of thumb: a switch over a union with a `void`-ish body has NO
 * compiler exhaustiveness check without this (reducers with explicit
 * return types already fail via TS2366). Only add it where the switch
 * would otherwise swallow a new variant silently — never to `e.key`-style
 * open-ended string switches.
 */
export function assertNever(value: never): never {
	throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
