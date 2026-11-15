# HeyClicky compatibility

Generated from `core/src/compat/heyclicky.ts` (`HEYCLICKY_SURFACE`).
OpenClicky copies the *surface* a HeyClicky model or client expects, never its code.

## `browser`

the user's Chrome through the extension: tabs, DOM snapshots, page actions

| HeyClicky action | OpenClicky command | Status | Notes |
|---|---|---|---|
| `open {url}` | `web.navigate` | implemented | fetches and returns title, text, links |
| `extract {tabId}` | `web.navigate` | degraded | re-reads the page text without refs |
| `snapshot {tabId}` | `web.state` | implemented | indexed role: name [ref] lines |
| `click {ref}` | `web.click` | implemented | ref maps to elementIndex |
| `fill {ref,text}` | `web.type` | implemented |  |
| `search {query}` | `web.search` | implemented | Brave when key 2 is set, DuckDuckGo otherwise |
| `tabs` | — | absent | single-tab runtime; no tab group yet |
| `batch {steps}` | — | absent | chain single calls for now |
| `javascript {code}` | — | absent | needs the Playwright worker tier |
| `press / scroll / wait_for / back` | — | absent | coming with the actor tier |
| `upload / download / dialog` | — | absent |  |
| `screenshot / click_at / hover_at / drag_at / type` | — | absent | pixel tier lands with the sandbox worker |
| `keep {tabId,why}` | — | absent | nothing to keep in a single-tab runtime |

## `mac_step`

one PC step on the user's own screen, shown as a card and approved first

| HeyClicky action | OpenClicky command | Status | Notes |
|---|---|---|---|
| `inspect screen` | `pc.a11y_tree` | degraded | returns the accessibility tree instead of performing a step |
| `screenshot` | `pc.screenshot` | implemented |  |
| `click / type / keys / scroll` | `pc.click | pc.type_text | pc.press_key | pc.scroll` | degraded | explicit commands instead of one outcome-driven step |
| `launch app` | `pc.launch_app` | implemented |  |
| `single outcome-driven step with a card` | — | absent | compose the pc.* commands above; HITL cards already gate them |

## `sessions_spawn`

hand background work to a helper task

| HeyClicky action | OpenClicky command | Status | Notes |
|---|---|---|---|
| `spawn` | — | absent | no sub-session runtime yet; the executor handles the whole turn |
| `send / status / interrupt / yield` | — | absent |  |

## `clicky_memory`

the assistant's long-term notes about the user

| HeyClicky action | OpenClicky command | Status | Notes |
|---|---|---|---|
| `read / save` | — | absent | memory lives in the host agent (Base44), not in the openclicky core |

## `clicky_artifacts`

files and documents the assistant produced

| HeyClicky action | OpenClicky command | Status | Notes |
|---|---|---|---|
| `list / open / reveal` | `pc.files.read` | degraded | plain file reads only |

