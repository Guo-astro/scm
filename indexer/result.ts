// Minimal Result envelope for indexer pure cores (L1 FP increment).
// Mirrors src/lib/result.ts so main <-> worker share one shape:
//   { ok:true, value } | { ok:false, error:string }
//
// Existing throw/return-null functions are kept for compat; new
// `*Result` variants return this envelope for IO boundaries where
// the caller needs the reason without try/catch.

export interface Result<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

export function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}

export function err(error: unknown): Result<never> {
	return {
		ok: false,
		error: typeof error === "string" ? error : String(error),
	};
}

export function isOk(r: unknown): boolean {
	return !!r && (r as Result<unknown>).ok === true;
}

export function tryCatch<T>(
	fn: () => T,
	onError?: (e: unknown) => string,
): Result<T> {
	try {
		return ok(fn());
	} catch (e) {
		const errAny = e as { message?: string } | null;
		const msg =
			typeof onError === "function"
				? onError(e)
				: String((errAny && errAny.message) || e);
		return err(msg);
	}
}
