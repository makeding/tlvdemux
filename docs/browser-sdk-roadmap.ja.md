# Browser playback SDK 集約計画

browser SDK は、各 consumer が複製すると不一致が生じる protocol と playback lifecycle を所有します。
demo は reference adapter とし、DPlayer を含む player は同じ public module を利用します。

## 共通 invariant

- SDK は TLV/MMT、MSE、Range、Worker、layer、recovery semantics を所有します。
- consumer は UI、product policy、表示文言、永続化、application event を所有します。
- 各 batch で現行 consumer をすべて移行し、旧 helper、branch、fixture、test を同時に削除します。
- demo と DPlayer に同一 lifecycle の別実装が残る状態では batch 完了としません。
- `rain.tlv` recovery acceptance は browser automation を使わず、native VideoToolbox、full-sample
  WASM、決定的 JS test を必須 gate とします。

## Batch 1: MSE output pipeline

paired video/audio init、pending media、SourceBuffer queue 作成、timestamp offset／splice／changeType／
init／media の順序、common A/V 観測、stable wait、finalize を一つの public pipeline に集約します。
MIME が同じ layer reconfiguration でも init を再適用し、source PTS ではなく `timestampOffsetUs` を
output timeline に反映します。

移行順は public module と queue-order test、demo、package release、DPlayer の通常 npm upgrade、
DPlayer 旧 callback glue 削除です。timestamp 0、`821944us`／`-821944us`、seek A/V coverage、
incomplete-tail finalize、JS/WASM、DPlayer type-check/test/build、VideoToolbox を acceptance とします。

## Batch 2: Track／layer selection

current MPT membership、selection level、同一 video group、対応 audio、caption／superimpose、audio
compatibility、preferred/fallback A/V pair を pure typed helper として公開します。automatic layer の
設定操作は SDK、UI mode と表示文言は consumer に残します。demo の `asset-groups.mjs`／
`subtitle-tracks.mjs` と DPlayer の重複 protocol selection を移行後に削除します。

## Batch 3: Worker RPC

typed async `DurationProbe`／`TlvDemuxer` proxy、transferable、callback cache、remote error、cancel、
destroy を bundler-safe な public Worker client/runtime として公開します。demo と DPlayer は
Worker/WASM URL と callback だけを渡し、二つの RPC 実装を削除します。

## Batch 4: Recorded source／duration

strict HTTP Range、source-size discovery、bounded DurationProbe、cancel、正確な転送 byte、local
random-access source を public abstraction にします。fetch、header、credential、authorization は
consumer injection のままです。demo と DPlayer の Range/Duration loop を削除し、recorded seek は
この source contract を直接利用します。録画全体 download への fallback は禁止します。

## Batch 5: Playback entry／recovery／stream helper

recorded/live entry gating、selected-layer playback damage recovery、live input coalescing を public module
へ移します。位置変更を許可するのは user の明示 seek、selected layer の
`PlaybackDamage.action === "seek"`、既存 live-start rule だけです。subtitle rendering と
data-broadcast DOM は consumer の責任です。

## Release／migration 順序

各 batch は public implementation と contract test -> demo reference consumer -> package release ->
DPlayer npm upgrade と migration -> DPlayer type-check/test/build -> observable surface が変わる場合の
HonomiTV acceptance の順です。sibling link、SDK file のコピー、lockfile 手編集を compatibility bridge
にしてはいけません。

## 現行 consumer の cutover inventory

public module と demo reference adapter を先に実装します。その後、明示的に許可された npm package
release を通常 install して DPlayer を切り替えます。sibling path や file copy は中間 integration に
使いません。以下は release 後に必ず削除する対象です。

| SDK module | 削除する DPlayer owner | 必須 boundary proof |
| --- | --- | --- |
| `mse-output-pipeline`／`mse-playback` | `src/ts/tlv-player.ts` の pending init/media、splice、finalize、startup/backpressure、64 MiB seek loop | timestamp 0、`821944us` offset、seek 全体 16 MiB、hidden seek なし |
| `track-selection` | `src/ts/tlv-layer-selection.ts` の protocol helper。product mode rollback orchestration だけ残す | current MPT、manual PID、fallback audio pair、非対応 channel 除外 |
| `worker-client`／public Worker runtime | `src/ts/tlv-worker-client.ts`／`src/ts/tlv-worker.ts` の RPC、proxy inventory、transfer、cache | inline Worker CSP、application/resource、clock、layout、service reset cache、nullable result |
| `recorded-source` | `src/ts/tlv-player.ts` の `discoverSourceSize()`、`probeDuration()`、`fetchRange()` | injected authenticated fetch、strict `Content-Range`、cancel、正確な byte 数 |
| `stream-input`／playback recovery | `src/ts/tlv-player.ts` の `coalesceLiveStream()` と playback damage helper | bounded live chunk、選択 layer のみ recovery、generation cancel |

DPlayer の application-resource cache は UI glue ではなく public Worker client の必須 contract です。
`applicationEntry`、application/resource snapshot、broadcast clock、layout、service reset、inline Worker
construction、remote error code を SDK がすべて持つまでは package publish 不可です。DPlayer の二つの
RPC file を削除するまで Worker batch は未完了です。HonomiTV は DPlayer 経由で利用するため、cutover 後に install 済み DPlayer
build と実際の TLV entry route を検証し、別の SDK lifecycle を複製しません。
