# Agent-First Design

Status: draft

Date: 2026-04-25

## Why this doc exists

autobrowser has crossed the point where it is no longer just a local browser relay plus extension bridge. It already exposes agent-friendly primitives:

- stable element refs from `snapshot` such as `@e1`
- stable frame refs from `snapshot` such as `@f1`
- stable tab handles such as `t1`
- semantic lookup through `find role`, `find text`, and `find label`

That is a good base, but it is still a thin command surface rather than a full agent runtime contract. This document describes the adjustments needed to keep pushing the project in an agent-first direction without losing the current lightweight local-first model.

## Current baseline

The current codebase already supports the following agent-oriented behavior:

- `snapshot` emits interactive element refs and visible frame refs.
- selector-based commands accept element refs directly.
- `frame` accepts frame refs directly.
- `tab list` exposes stable handles and `tab select` / `tab close` can act on them.
- `find role`, `find text`, and `find label` can locate a target and optionally act on it.

The current architecture is still extension-first:

- CLI parses commands and forwards them to the local IPC server.
- the local runtime forwards commands to the browser extension over the relay socket.
- the extension owns active tab selection, frame selection, DOM lookup, network interception, and snapshot generation.

This is workable, but several agent-facing contracts are still incomplete.

## Design goals

- Keep the tool deterministic and low-friction for coding agents.
- Prefer stable handles over brittle CSS selectors.
- Make command responses compact, structured, and consistent.
- Reduce the number of turns an agent needs to complete common workflows.
- Detect stale state explicitly instead of silently doing the wrong thing.
- Preserve the current local-first deployment model.

## Non-goals

- This design does not assume a built-in natural language planner or chat agent inside autobrowser.
- This design does not require moving away from the current extension-based execution model immediately.
- This design does not try to match every agent-browser feature before the core contract is stable.

## Main gaps

### 1. Targeting is not uniform enough

Stable tab handles exist, but most commands still act on the implicit current target rather than a uniform explicit target contract.

Current impact:

- an agent can select a tab with `tab select t2`, but many commands cannot say `run this against t2` directly
- frame selection is still mostly a mutable ambient state
- responses do not consistently echo the effective tab handle and frame ref they used

### 2. Locator semantics are still first-match only

`find` is useful, but it still behaves like a single-match shortcut rather than a full semantic selection layer.

Current impact:

- no candidate ranking or top-N results
- no `first`, `last`, `nth`, or score-based selection
- no strategies for placeholder, alt text, title, test id, or exact accessible name beyond the current subset

### 3. Refs have no explicit staleness model

Element refs and frame refs are derived from the current DOM, but the runtime does not expose a page epoch or snapshot epoch that lets an agent know whether a ref is stale.

Current impact:

- agents have to guess when to refresh `snapshot`
- commands can fail late instead of reporting a structured stale-ref error
- there is no machine-readable invalidation contract after navigation or heavy re-render

### 4. Agent I/O is still too ad hoc

The current response payloads are reasonable for humans, but not yet a clean agent contract.

Current impact:

- different commands return different shapes for similar outcomes
- success payloads do not always include the target handle, frame ref, or page metadata
- error payloads are not normalized around explicit error codes and remediation hints

### 5. Too many agent workflows still require multiple turns

The current command model is one command at a time.

Current impact:

- `snapshot -> choose ref -> click -> wait -> read text` requires many round trips
- an agent cannot submit a small deterministic command batch atomically
- there is no reusable macro or script layer with structured results

### 6. Observability is weaker than the command surface

The repo has strong unit coverage for routing and helper behavior, but it still lacks agent-oriented validation loops.

Current impact:

- no real-browser smoke suite for core agent workflows
- no eval corpus for semantic matching quality
- no regression suite for stale refs, multi-tab flows, or nested frames

## Proposed adjustments

## A. Define a uniform target contract

Every agent-relevant command should accept the same target dimensions:

- `tab`: optional stable tab handle such as `t2`
- `frame`: optional stable frame ref such as `@f1`
- `snapshotId`: optional snapshot or page epoch identifier when acting on refs

Recommended CLI shape:

```bash
autobrowser click @e3 --tab t2 --frame @f1
autobrowser get text @e9 --tab t3
autobrowser find role button click --name "Submit" --tab t2
```

Recommended runtime rule:

- explicit target overrides ambient state
- ambient state is still allowed for interactive human usage
- every response echoes `tabHandle`, `frameRef`, and `pageEpoch` when relevant

## B. Expand `find` into a real semantic locator layer

`find` should become the main semantic targeting interface rather than a thin shortcut.

Recommended additions:

- strategies: `placeholder`, `alt`, `title`, `testid`
- selectors: `first`, `last`, `nth`, `all`
- result modes: `locate`, `list`, `count`
- metadata: accessible name, role, text snippet, score, match reason

Recommended response shape:

```json
{
  "found": true,
  "strategy": "role",
  "query": "button",
  "matches": [
    {
      "ref": "@e4",
      "role": "button",
      "name": "Submit",
      "score": 0.98,
      "reason": "role+name exact match"
    }
  ],
  "selected": "@e4"
}
```

This lets an agent inspect candidates before acting when ambiguity matters.

## C. Introduce page epochs and stale-ref detection

The runtime should version page state explicitly.

Recommended fields:

- `pageEpoch`: increments after navigation, reload, or DOM reset events that invalidate refs
- `snapshotId`: unique id returned by each `snapshot`
- `refEpoch`: optional epoch attached to refs in snapshot output

Recommended behavior:

- a command that receives `@e4` can validate whether the current page epoch still matches
- stale refs return a structured error like `STALE_ELEMENT_REF`
- the error should tell the agent to refresh `snapshot`

## D. Normalize command response envelopes

Agent-facing commands should converge on a small number of response shapes.

Recommended envelope:

```json
{
  "ok": true,
  "target": {
    "tabHandle": "t2",
    "frameRef": "@f1",
    "pageEpoch": 17
  },
  "result": { ... }
}
```

Recommended error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_ELEMENT_REF",
    "message": "element ref @e4 is stale for page epoch 16",
    "suggestedAction": "run snapshot again"
  }
}
```

This is more valuable to agents than adding many more commands with inconsistent payloads.

## E. Add batch execution for deterministic multi-step work

The next high-leverage runtime capability is a small batch layer.

Recommended scope:

- execute a list of existing commands in order
- optionally stop on first failure
- return per-step results and the final target context

Example:

```bash
autobrowser batch \
  'snapshot' \
  'find role button click --name Continue' \
  'wait --text Welcome'
```

This keeps autobrowser simple while cutting agent round trips substantially.

## F. Improve waits around agent primitives

Waits should be able to speak the same handle language as other commands.

Recommended additions:

- `wait @e7 --state hidden`
- `wait --tab t2 --url "**/dashboard"`
- `wait --frame @f1 --text "Loaded"`
- `wait --event navigation`

The important part is not more syntax. The important part is that waits understand tab handles, frame refs, and page epochs consistently.

## G. Strengthen testing around agent workflows

The project now needs tests for behavior, not only routing.

Recommended additions:

- real-browser smoke tests for `snapshot`, `find`, `tab select`, and `frame @fN`
- semantic locator fixtures for role, text, and label matching quality
- stale-ref tests after navigation or DOM replacement
- multi-tab and nested-frame regression cases
- a lightweight eval corpus for ambiguous matches and dynamic UIs

## H. Publish an explicit agent contract page

Agent users need one canonical contract page, not just examples scattered across README sections.

Recommended contents:

- stable handle model: `tN`, `@eN`, `@fN`
- when refs are valid and when they become stale
- how `find` ranking works
- response envelope conventions
- best-practice workflow examples

This document can evolve into that page, but the contract should eventually be shorter and more normative than this design note.

## Recommended rollout

### Phase 1: contract hardening

- add explicit target overrides for tab handle and frame ref across all relevant commands
- normalize response envelopes and error codes
- add page epoch and stale-ref detection

### Phase 2: semantic selection depth

- extend `find` with candidate listing, ranking, and more strategies
- add `first`, `last`, `nth`, and `all`
- add better ambiguity reporting

### Phase 3: agent throughput

- add `batch`
- add reusable macros or scripts only if batch proves insufficient
- add targeted waits that understand the same handle model

### Phase 4: validation and productization

- add smoke tests and evals
- publish the agent contract page
- decide whether the extension-first runtime remains sufficient or whether a native sidecar path is needed later

## Recommended next milestone

If only one milestone is funded next, it should be this:

- unify `--tab` and `--frame` targeting across commands
- add page epoch plus stale-ref detection
- expand `find` from first-match to candidate-aware matching

That combination improves correctness more than adding many new surface commands.

## Open questions

- Should tab labels be user-assigned next, or are stable generated handles enough for now?
- Should `snapshot` eventually expose a compact and a verbose mode?
- Should the project stay fully extension-first, or prepare a future native-CDP execution path for sites where extension behavior is constrained?
- Should `batch` be line-oriented CLI syntax, JSON input, or both?

## Summary

autobrowser already has the right first agent primitives. The next step is not a large expansion of commands. The next step is to turn refs, handles, semantic lookup, and state invalidation into a consistent runtime contract that agents can trust.
