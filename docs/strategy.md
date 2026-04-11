# Almide Graphics Stack — Module Strategy

**Status:** draft / open questions
**Last updated:** 2026-04-11
**Scope:** how `almide/obsid` and its sibling graphics packages evolve over the next few releases.

This document exists so the module boundaries, layering, and feature scope
of the graphics stack get decided deliberately rather than each time a new
capability is requested. Nothing here is binding until the open questions
in §3 are answered.

---

## 1. Current Landscape

Four graphics packages exist today, all at `v0.1.0`:

| Package | Size | Purpose | Backend |
|---|---|---|---|
| `almide/svg` | — | Static SVG text output (print, reports) | Pure Almide, no runtime |
| `almide/wasm-canvas` | 5.8 KB | Imperative Canvas 2D wrapper | Browser Canvas 2D API |
| `almide/wasm-webgl` | 17 KB | Low-level WebGL bindings + mat4 helpers | Browser WebGL |
| `almide/obsid` | 3.8 KB | 3D mesh / camera / light / fog scene engine | Browser WebGL (via thin JS bridge) |

### Unoccupied territory

- **GPU-accelerated 2D vector** (Skia-like): paths, gradients, blend modes, filters
- **Text rendering** (font loading, shaping, glyph layout)
- **Chart / dataviz** (bar, line, pie, heatmap)
- **Graph / diagram** (node-edge layout, flowcharts)
- **UI / widgets** (higher-level interactive primitives)

---

## 2. Core Questions

Each of these has to be answered before we commit code to any new package.
Answers drive the layering in §4.

### A. Layering strategy

Do `obsid`, `canvas2d`, `chart`, `graph` share a common base, or are they
each self-contained?

- **A1 — shared `almide/gfx` base:** one low-level package (mesh upload,
  texture, shader, FBO, mat4, blend) that every higher package depends on.
  No code duplication; deeper dependency graph.
- **A2 — self-contained packages:** each package ships its own low-level.
  Current state. Simple to reason about, duplicated work.
- **A3 — opt-in shared base:** `gfx` exists but is voluntary. `obsid` stays
  self-contained where it already is; new packages (`canvas2d`, `chart`) can
  adopt `gfx` for faster bootstrapping.

**Blocker:** we don't know how effective Almide's DCE is across package
boundaries. If DCE aggressively strips unused `gfx` surface from each
consumer, A1 is viable; if not, A3 is the pragmatic middle.

### B. obsid's scope

Does `obsid` stay a 3D engine, or grow into a general-purpose graphics
engine (2D + 3D on one mesh pipeline)?

- **B1 — 3D only:** keeps `obsid` at ≤10 KB, 2D lives in a sibling package.
  Clear scoping, easier LLM code generation (smaller API surface).
- **B2 — unified graphics engine:** 2D and 3D share the same mesh pipeline.
  3D space can host 2D overlays naturally. Binary grows to an estimated
  15–25 KB after all 2D features land. Larger API surface.

### C. Backend abstraction

Is the graphics stack browser-only, or designed for cross-host reuse?

- **C1 — browser only:** `@extern(wasm, "obsid", …)` targets the browser JS
  bridge. Native / mobile / headless ship separately later.
- **C2 — abstract host interface:** the `obsid.*` / `canvas2d.*` FFI
  contracts are host-agnostic. A browser host (WebGL), a native host
  (GL / Vulkan / Metal), and a headless host (software raster) are separate
  implementations of the same import surface. Almide user code runs
  unchanged across hosts — a strong strategic moat, at the cost of
  maintaining multiple host implementations.

### D. `wasm-canvas` vs a GPU 2D vector package

If we build a Skia-like GPU 2D package, it overlaps with the existing
`wasm-canvas`.

- **D1 — deprecate `wasm-canvas`:** consolidate on the GPU path. Users
  migrate. Fewer packages, breaks existing users.
- **D2 — keep both, differentiated:** `wasm-canvas` = thin browser API
  wrapper, frozen feature set, 5.8 KB selling point. GPU 2D = custom
  renderer with paths / text / filters. Different audiences.
- **D3 — GPU 2D layered over `wasm-canvas`:** hard cases (text rasterization,
  system fonts) fall back to browser API. Ties the GPU package to a browser
  host — kills C2.

### E. Text rendering ownership

Where does glyph layout / rasterization live?

- **E1 — per-package:** `obsid` and `canvas2d` each roll their own. Code
  duplication on the biggest subsystem in the stack.
- **E2 — `almide/text` standalone package:** SDF atlas baking + runtime
  layout + shaping, imported by whoever needs it. Smallest total cost.
- **E3 — delegate to browser `fillText`:** cheap, quality varies, blocks C2.

### F. `v1.0` freeze order

Every package is currently `v0.1.0` / experimental. To build a real
ecosystem we need at least a couple of `v1.0` freezes. Freezing a package
commits us to API stability.

**Candidate freeze order:**
1. `wasm-webgl` (mature, API mirrors WebGL 1 directly)
2. `obsid` (small enough that v1 is reachable after 1–2 more releases)
3. `canvas2d` / `text` (once built)
4. `chart` / `graph` (build on top of a stable base)

**Freeze criteria to define:**
- API test coverage threshold
- LLM modification survival rate benchmark result
- Minimum number of shipped example files

### G. Differentiation axis

Which axes do we optimize for? These are the candidates; we can't realistically
lead on all five.

| Axis | Strength relative to Skia / Cairo / three.js |
|---|---|
| **Binary size** | KB range vs MB — about 1/100 |
| **LLM-friendly authoring** | Almide's modification survival rate focus |
| **Zero-copy pipeline** | Almide linear memory → GPU, no FFI encode step |
| **Gamma-correct from day one** | Linear lighting + sRGB encode, no retrofit |
| **Cross-host** | (conditional on C2) write-once-run-anywhere WASM |

Tentative ranking: **tiny binary** + **LLM authoring** are the two that
Almide is structurally advantaged on. Zero-copy and gamma-correct are
table stakes we already meet. Cross-host is a strategic bet depending on C2.

---

## 3. Open Decisions

| # | Decision | Options | Tentative |
|---|---|---|---|
| D1 | Layering (§A) | A1 / A2 / A3 | **A3** (opt-in `gfx`) |
| D2 | obsid scope (§B) | B1 / B2 | **B1** (stay 3D-only) |
| D3 | Backend (§C) | C1 / C2 | **C2** (abstract host, native later) |
| D4 | `wasm-canvas` (§D) | D1 / D2 / D3 | **D2** (coexist, differentiated) |
| D5 | Text (§E) | E1 / E2 / E3 | **E2** (`almide/text` standalone, SDF) |
| D6 | v1.0 order (§F) | — | **`wasm-webgl` → `obsid` → `canvas2d`** |
| D7 | Top axes (§G) | 1–2 axes | **tiny binary + LLM authoring**, cross-host as a bonus |

None of the tentative picks are committed. They are starting positions for
the next round of discussion.

---

## 4. Strategic Map (tentative, assuming §3 tentative picks)

```
                  ┌──────────── Application ────────────┐
                  │                                     │
        ┌─────────┼──────────┬─────────────┬────────────┤
        │         │          │             │            │
      chart     ui /       graph        canvas2d      obsid
      (TBD)     widgets    (TBD)         (TBD)         (3D)
                (TBD)                      │            │
                                           └─────┬──────┘
                                                 │
                        ┌────────────────────────┼────────────────┐
                        │                        │                │
                    gfx (opt-in)               text          wasm-canvas
                    (mesh, texture,          (SDF atlas,     (Canvas 2D
                     shader, FBO,             layout,         wrapper;
                     mat4, blend)             shaping)        frozen feature set)
                        │
                        ▼
                   wasm-webgl
                   (raw GL bindings)
                        │
                        ▼
                   host via @extern
                   (browser | native | headless)
```

Layer responsibilities (under the tentative picks):

- **Application layer** — user code. Imports one or more of the
  domain-specific packages.
- **Domain packages** (`chart`, `graph`, `obsid`, `canvas2d`, …) — opinionated
  APIs for specific use cases. Each targets a clean LLM-authorable surface.
- **`gfx`** — shared base for mesh / texture / shader / FBO / blend / matrix.
  Opt-in: packages that need only a subset can still roll their own.
- **`text`** — SDF atlas + runtime layout + shaping. Used by any package
  that needs glyphs.
- **`wasm-webgl`** — raw WebGL 1 bindings. The lowest layer still written in
  Almide-space.
- **Host** — platform-specific implementations of the `@extern(wasm, …)`
  contracts. Browser, native, headless.

---

## 5. Sequencing

Once §3 is committed, the sequencing falls out almost automatically:

1. **Instrument DCE** across package boundaries to decide A1 vs A3 empirically.
2. **Freeze `wasm-webgl` v1.0** — it's the most stable base.
3. **Extract `almide/gfx`** from `obsid` (if A1 or A3 is picked), leaving
   `obsid` as a thin 3D scene layer on top.
4. **Build `almide/text`** (SDF baking tool in Almide, runtime atlas lookup,
   shaping — ship one default font baked in).
5. **Build `almide/canvas2d`** — paths, gradients, blend modes, offscreen
   layers, filters — in the phased roadmap already sketched (§6).
6. **Build `almide/chart`** and `almide/graph` on top of the stable base.

---

## 6. canvas2d phased roadmap (rough, not committed)

| Phase | Scope | Depends on |
|---|---|---|
| v0.2 | ortho camera, draw_rect / line / circle, 2D mode toggle | existing mesh path |
| v0.3 | paths (moveTo / lineTo / quad / cubic), fill, stroke with cap/join | tessellator |
| v0.4 | gradients (linear, radial), blend modes, blend variants | shader variants |
| v0.5 | offscreen layers, clip (stencil), save / restore stack | FBO in `gfx` |
| v0.6 | Gaussian blur, drop shadow, color matrix filter | layers |
| v0.7 | SDF text rendering | `almide/text` |

This is a sketch; the actual cut points depend on how big each phase ends
up being and which user requests land first.

---

## 7. What we need before writing code

Before any package under this plan ships a commit, we need:

1. Answers to D1–D7 (or explicit "still open" with a tie-breaker).
2. A DCE measurement experiment for A1 vs A3, if that decision remains
   tentative.
3. A LLM modification survival rate benchmark scaffolding for the freeze
   criteria in F.
4. A written v1.0 policy checklist (once a version is frozen, what constitutes
   a breaking change?).

Until then, this doc stays a strategy draft, not a roadmap commitment.
