// UI feature flags — one place to park a finished feature without deleting
// it. Shared (renderer + Node side) so a future main-process gate can read
// the SAME constant instead of growing a second switch.
//
// Flipping a flag to true is the whole revival story: every Ask-mode entry
// point below is already imported, typed, and unit-tested, so nothing else
// needs re-wiring. While a flag is false the feature's backend (IPC
// handlers, llm config, model registry, `test:ask`) stays intact and keeps
// being exercised — only the user-facing surfaces disappear.

/**
 * Ask / "LLMs Chat" mode.
 *
 * Parked (2026-10): the Settings → LLMs Chat section, the LLMs search pill,
 * the answer card, and the ⌘5 "All tab + LLMs chat" view row are all hidden.
 * `memories:ask`, `main-lib/llm/*`, and `main-lib/ask/*` are untouched, and
 * an existing `llm.enabled: true` in settings.json is inert because the
 * renderer never renders a way to ask.
 *
 * Gate sites:
 *   - src/hooks/useAsk.ts               `enabled` (single choke point)
 *   - src/components/SettingsSheet.tsx  visible section list + Keyboard view list
 *   - src/components/MasonryGrid.tsx    consumes useAsk's `enabled` for the
 *                                       pill, badge, answer card, ⌘5 dispatch
 */
export const ASK_MODE_VISIBLE = false;
