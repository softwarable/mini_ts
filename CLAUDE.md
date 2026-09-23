# mini.ts: maintainer notes

A personal, single-file UI library. `mini.ts` is the entire library. Keep it that way until it passes ~3,000 lines. At that point, split it into modules that bundle back into one `dist/mini.js`, without changing the public API.

## Layout

- `mini.ts`: the library, in six banner-separated sections: Signals, Templates, Components, Behaviors, Fetch, Startup.
- `tests/*.test.ts`: unit tests (Vitest + happy-dom), one file per area. Most tests belong here.
- `tests-browser/*.test.ts`: real Chromium tests (Vitest browser mode + Playwright) for things happy-dom can't model: custom-element lifecycle, shadow DOM/stylesheets, computed styles, focus, native forms, real HTTP. `tests-browser/server.ts` is the real test backend (`/test-api/*`).
- `demo/`: a Vite demo page (`npm run dev`). `demo/api.ts` is a fake backend middleware.
- `README.md`: user docs. Update it with every public API change.

## Commands

- `npm test`: runs both suites. It must pass before any change is done. Use `npm run test:unit` for quick iterations.
- Playwright is pinned to an exact version to match the installed Chromium build. Don't bump it casually; if you do, run `npx playwright install chromium`.
- `npm run typecheck`: must be clean.
- `npm run size`: check that gzip stays under **12 KB**. Mention the size change when it grows by more than 0.5 KB.
- `npm run build`: produces `dist/mini.js` and `dist/mini.d.ts`.

## Design rules

- **Generic only.** This library is shared by several projects. No application-specific code, config defaults, names, URLs, tests, demo content or docs. Settings that differ per app (CSRF cookie/header names, base URLs…) are configured by the app through `config`, never hard-coded here.

- **No runtime dependencies.** Dev dependencies only: typescript, vite, vitest, happy-dom.
- **No work at import time.** Nothing touches the DOM or adds listeners until the user calls `start()`, `render()`, `define()` and so on. This keeps the file tree-shakeable and importable from tests.
- **Small, stable public API.** Every export is documented in README.md. Prefer adding an option over adding a new concept. Internal helpers stay unexported.
- **Templates:** a Lit-style design. Each template is parsed once per call site (cached by the `strings` array), and updates only touch the parts whose values changed. There is no virtual DOM. Unsupported binding positions must throw a clear error, never fail silently.
- **Escaping:** text and attribute values are always escaped (text nodes / `setAttribute`). Only `unsafeHTML` and fetch swaps insert raw HTML.
- **Components:** `render()` runs inside an effect scheduled once per microtask. Props are backed by per-instance signals through prototype accessors. Values set before upgrade win over class-field defaults.
- **Behaviors and fetch:** everything goes through one delegated listener per event type on the root (capture phase only for non-bubbling events). A MutationObserver mounts and unmounts behaviors.
- **Security:** the CSRF token (`config.csrf`) is only ever sent to the page's own origin (`isSameOrigin`). Declarative non-GET requests to other origins are refused. Keep both rules for any new request path.
- **Reads vs writes:** a pending GET may be aborted (newer request, element removed). A pending write (POST/PUT/PATCH/DELETE) is never aborted, and repeat triggers are ignored while it runs. Keep this distinction for any new request feature.
- **Progressive enhancement:** `data-fetch` must behave like the native form or link would (method rules, `formaction`/`formmethod`, `dialog`, modifier-clicks, native validation).
- **Errors in user callbacks** (behaviors, actions) are caught and logged with a `mini:` prefix, so one bad handler doesn't break the page.
- **Browser target:** evergreen browsers only. No IE, no polyfills.

## When changing code

1. Add or adjust tests first in the matching `tests/*.test.ts`. Bugs get a regression test.
2. Keep the code style: 2 spaces, no semicolons, single quotes, `#private` fields, short doc comments on exports.
3. Run `npm test && npm run typecheck && npm run size`.
4. For DOM behavior that happy-dom may not model (focus, layout, native forms, real fetch), add or extend a test in `tests-browser/`.
5. Update README.md for any user-visible change.

## Known limits / ideas for later

Nothing below is built yet. Add an item only when a real project needs it.

- `data-push-url` / history support for fetch swaps
- Polling triggers (`every 5s`) and key filters (`keyup[Enter]`)
- Out-of-band swaps (several targets from one response)
- A `ref()` directive for element references in templates
- Scoped styles for light-DOM components
