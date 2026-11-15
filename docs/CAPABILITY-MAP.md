# Capability map — what each studied agent contributed to OpenClicky

All four agents were reverse-engineered from their production builds
(private study, `alyxlab` repo). OpenClicky is clean-room: patterns only,
no code.

| Pattern | HeyClicky | OpenAI Dots | Grok Bot | Meta Muse | In OpenClicky |
|---|---|---|---|---|---|
| Brain in a separate process over typed RPC | ✔ (app-server) | ✔ (codex-app-server, WS RPC) | ✔ (protobuf) | ✔ | `protocol/` + `core/` executor |
| Typed versioned device commands | partial | ✔ sky window2 | ✔ | ✔✔ Hatch nodes (`*_v1`) | `CommandSpec` with versions |
| Capabilities advertised upward | – | ✔ | – | ✔✔ HatchCapabilitiesSnapshot | `CapabilitySnapshot` gating the planner |
| HITL approval objects / scoped grants | confirm prompts | ✔ confirmations policy | – | ✔✔ NodeHitl modes+scopes | `HitlEngine` (`AUTO`/`ASK_ONCE`/`ASK_ALWAYS`/`NEVER`) |
| Screen capture + input injection | ✔ Win32 | ✔ UIA+SendInput+WGC | – | – | `pc-host` runtime contract |
| Accessibility-tree control (token-cheap) | – | ✔✔ | partial (DOM) | partial | `web.state` a11y-diff spec |
| Browser in disposable sandbox | – | ✔ (CUA runtime) | ✔✔ Debian container/bot | ✔✔ leased attested CVM | `sandbox/` worker: Playwright engine, stdio protocol, Dockerfile |
| Live view + human takeover | – | – | – | ✔✔ AgentBrowserTakeoverControls | viewport `StreamFrame`s after actions + `runtime.control()` (takeover/release/cancel) |
| Proactive triggers + backfill diffs | – | – | – | ✔✔ HatchProactiveTriggerManager | `pc.files.watch` + `pc.hotkey.listen` → `TriggerEvent` wakes the executor |
| Connectors (OAuth/API-key/scopes) | skills | plugins | – | ✔✔ skills/connect | connector gateway: API-key + OAuth2 PKCE, AES vault, scoped calls |
| Local model option (no cloud dependency) | ✔✔ ONNX | – | – | – | model-agnostic core; point base-URL at any local server |
| Rich result cards | – | – | – | ✔✔ HatchNodeCards | `Card` results from search + connector auth links |
| Voice front-end | – | ✔ dictation | – | ✔✔ full pipeline | panel mic/speaker over OpenAI-compatible audio endpoints |
| Cross-device session handoff | – | ✔ phone-as-client | – | ✔✔ watch handoff | later milestone |

Key takeaways baked into the design:

- **Muse taught the permission model** — it is the only one of the four with
  approval as a first-class protocol object, and it shows.
- **Dots taught the actuator API** — per-window state, indexed accessibility
  elements, explicit launch/list/act workflow.
- **Grok Bot taught isolation** — per-task sandbox workers beat giving an
  agent your real browser profile.
- **HeyClicky taught locality** — an agent that can run its model at home is
  an agent people can actually trust with their screen.
