import { expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorBoundary from "../src/components/ErrorBoundary";

// No DOM harness in this repo (no jsdom/RTL): error boundaries cannot be
// exercised by rendering a throwing child through react-dom/server, but the
// two halves that make the fallback correct are pure — the static state
// derivation and the render with an error state. Those are what this pins.

interface BoundaryLike {
	state: { error: Error | null };
	render(): ReactNode;
	componentDidCatch(
		error: Error,
		info: { componentStack?: string | null },
	): void;
}

function boundary(state: Error | null, children: ReactNode = null) {
	const Ctor = ErrorBoundary as unknown as new (props: {
		children: ReactNode;
	}) => BoundaryLike;
	const instance = new Ctor({ children });
	instance.state = { error: state };
	return instance;
}

test("getDerivedStateFromError normalizes Error and non-Error throws", () => {
	const fromError = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
	expect(fromError.error).toBeInstanceOf(Error);
	expect(fromError.error?.message).toBe("boom");

	const fromString = ErrorBoundary.getDerivedStateFromError("nope");
	expect(fromString.error).toBeInstanceOf(Error);
	expect(fromString.error?.message).toBe("nope");
});

test("renders children untouched when there is no error", () => {
	const markup = renderToStaticMarkup(
		boundary(null, createElement("div", { id: "ok" }, "ok")).render(),
	);
	expect(markup).toBe('<div id="ok">ok</div>');
});

test("fallback is an alert with a reload path and the error message", () => {
	const markup = renderToStaticMarkup(boundary(new Error("boom")).render());
	expect(markup).toContain('role="alert"');
	expect(markup).toContain("Something went wrong");
	expect(markup).toContain("Reload");
	expect(markup).toContain("boom");
	// The user-facing promise: the library is safe.
	expect(markup).toContain("Your library is safe");
});

test("componentDidCatch never throws without a bridge (headless)", () => {
	const instance = boundary(new Error("boom"));
	const orig = console.error;
	console.error = () => {};
	try {
		expect(() =>
			instance.componentDidCatch(new Error("boom"), {
				componentStack: " at Grid",
			}),
		).not.toThrow();
	} finally {
		console.error = orig;
	}
});
