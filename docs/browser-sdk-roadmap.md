# Browser playback SDK convergence plan

The browser SDK owns protocol and playback lifecycle behavior that every
consumer would otherwise have to reproduce. The demo remains a reference
adapter; DPlayer and other players must consume the same public modules rather
than copy their implementation.

## Invariants

- SDK modules own TLV/MMT, MSE, Range, Worker, layer, and recovery semantics.
- Consumers own UI, product policy, labels, persistence, and application events.
- Every batch migrates all current consumers and removes the superseded helper,
  branch, fixture, and test in the same delivery.
- A batch is not complete while demo and DPlayer still implement different
  versions of the same lifecycle.
- Browser automation is not part of the `rain.tlv` recovery acceptance path.
  Native VideoToolbox, full-sample WASM, and deterministic JS tests remain the
  required gates.

## Batch 1: MSE output pipeline

Publish one pipeline that owns paired video/audio initialization, pending media,
SourceBuffer queue creation, ordered timestamp-offset/splice/changeType/init/media
mutation, common A/V observation, stable waiting, and finalization. It must
preserve layer reconfiguration even when MIME is unchanged and must apply
`timestampOffsetUs` rather than treating source PTS as output time.

Migration:

1. Add the typed public module and direct queue-ordering tests.
2. Convert the demo to callbacks supplied by the pipeline.
3. Publish the package version containing the module.
4. Upgrade DPlayer through its normal npm manifest/lockfile flow, migrate its
   callbacks, and delete its pending-init/segment/splice implementation.

Acceptance: startup timestamp 0, rainfall `821944us` / `-821944us`, seek A/V
coverage, unchanged-MIME layer reinitialization, incomplete-tail finalization,
JS/WASM suites, DPlayer type-check/test/build, and native VideoToolbox.

## Batch 2: Track and layer selection

Publish pure typed helpers for current-MPT membership, selection level,
same-video-group membership, corresponding audio, caption/superimpose
classification, audio compatibility filtering, and preferred/fallback A/V pair
resolution. Publish the automatic-layer configuration operation, but retain UI
mode changes and rollback messages in the consumer.

Migration: replace `demo/asset-groups.mjs`, `demo/subtitle-tracks.mjs`, and
DPlayer's duplicated protocol-selection functions, then remove those old
readers and their fixtures.

Acceptance: explicit PID remains fixed, automatic mode uses only the current
MPT, fallback audio matches group and selection level, unsupported multichannel
audio is excluded honestly, manual mode preserves layer-health observations so
returning to automatic immediately restores a healthy preferred A/V pair, and
every existing selection test targets the public module.

## Batch 3: Worker RPC

Publish a bundler-safe Worker client/runtime with typed asynchronous
`DurationProbe` and `TlvDemuxer` proxies, transferable payload handling,
callback caches, stable remote errors, cancellation, and deterministic object
destruction.

Migration: demo and DPlayer provide only Worker/WASM URLs and callbacks. Delete
both copied RPC clients and duplicated proxy method inventories.

Acceptance: every public WASM method used by either consumer crosses the Worker
boundary with its real return value, `null` is preserved, callbacks stop after
destruction, and both direct and Worker-backed SDK suites pass.

## Batch 4: Recorded source and duration

Publish a recorded-source abstraction and coordinators for strict HTTP Range
validation, source-size discovery, bounded duration probing, cancellation,
exact transferred-byte accounting, and local random-access sources. Fetch,
headers, credentials, and authorization remain injected by the consumer.

Migration: remove demo and DPlayer Range/Duration loops. The recorded seek
session consumes this source contract directly.

Acceptance: malformed `Content-Range`, truncated bodies, unsupported Range,
probe failure, cancellation, and exact request accounting have direct tests;
no recovery path falls back to downloading the complete recording.

## Batch 5: Playback entry, recovery, and stream helpers

Move recorded/live playback-entry gating, selected-layer playback-damage
recovery, and live input coalescing into public modules. Recovery may reposition
only for an explicit user seek, selected-layer `PlaybackDamage.action ===
"seek"`, or the existing live-start rule. Subtitle rendering and data-broadcast
DOM remain consumer responsibilities.

Acceptance: no hidden seek, no recovery from an unselected layer, generation
and restart races cancel cleanly, live coalescing is bounded, and error codes
remain visible to the consumer.

## Release and migration order

Each batch follows: public implementation and contract tests -> demo reference
consumer -> package release -> DPlayer npm upgrade and migration -> DPlayer
type-check/test/build -> HonomiTV integration acceptance when its observable
surface changes. Never use sibling links, copied SDK files, or hand-edited
lockfiles as a compatibility bridge.

## Current consumer cutover inventory

The public modules and demo reference adapter land first. An explicitly
authorized npm package release then gives DPlayer one normal installed version
to consume; sibling paths or copied files are not an intermediate integration
mechanism. The rows below are the concrete post-release removal list, not
optional follow-up work.

| SDK module | DPlayer owner to replace | Required boundary proof |
| --- | --- | --- |
| `mse-output-pipeline` and `mse-playback` | `src/ts/tlv-player.ts` pending init/media, splice, finalize, startup/backpressure, and 64 MiB seek loops | timestamp 0, `821944us` offset, explicit seek 16 MiB total, no hidden seek |
| `track-selection` | protocol helpers in `src/ts/tlv-layer-selection.ts`; retain only product-mode rollback orchestration there | current-MPT filtering, manual PID, paired fallback audio, unsupported-channel filtering |
| `worker-client` and public Worker runtime | `src/ts/tlv-worker-client.ts` and `src/ts/tlv-worker.ts` RPC, proxy inventories, transfer logic, and caches | inline Worker CSP behavior; application/resource, clock, layout and service-reset caches; exact nullable return values |
| `recorded-source` | `discoverSourceSize()`, `probeDuration()`, and `fetchRange()` in `src/ts/tlv-player.ts` | injected authenticated fetch, strict `Content-Range`, cancellation, exact bytes |
| `stream-input` and playback recovery | `coalesceLiveStream()` and copied playback-damage helper in `src/ts/tlv-player.ts` | bounded live chunks, selected-layer-only recovery, generation cancellation |

DPlayer's application-resource cache is a required public Worker-client
contract, not UI glue. The public Worker package is not publishable until
`applicationEntry`, application/resource snapshots, broadcast clock,
layout configuration, service reset, inline-worker construction, and remote
error codes are all carried by the SDK implementation. The Worker batch is not
complete until the two DPlayer RPC files are deleted. HonomiTV consumes this
through DPlayer, so it needs an installed DPlayer build and the real TLV entry
route after that cutover; it does not receive a second copy of these SDK
lifecycles.
