# tlvdemux

[English](README.md) | 日本語

`tlvdemux` は、復号済み ARIB MMT/TLV ストリーム向けの C++20 playback、
fMP4/MSE、WASM 統合層です。プロトコル解析とデータ放送リソースのコアは
[libaribtlv](https://github.com/makeding/libaribtlv) に分離し、ここでは MPEG-TS
への変換や FFmpeg ABI 型の公開なしに、HEVC、AAC-LATM/LOAS、ARIB STD-B62 TTML
をプレイヤーへ渡します。

現在の実装は、安定した公開コールバック API、上限付きのインクリメンタルな
TLV 再同期、圧縮 IP コンテキストの分離、MMTP のフラグメント／アグリゲーション、
PA/M2/MPT によるトラック検出、記述子に基づくタイムライン、および
HEVC/AAC-LATM/TTML アクセスユニット出力を提供します。

## ビルドとテスト

```sh
nix-shell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

プロトコル実装と Zlib 依存は `libaribtlv` が所有します。デフォルトでは HTTPS
リポジトリの固定 revision `6ecf9e3b1a8fd95563bc5071213b67b936ea01b3` を CMake が
取得します。オフライン開発では `TLVDEMUX_LIBARIBTLV_SOURCE_DIR` にローカル
checkout を指定します。インストール済み package を使う場合は
`TLVDEMUX_USE_SYSTEM_LIBARIBTLV=ON` と `CMAKE_PREFIX_PATH` を指定してください。
ローカル source directory の指定が常に優先されます。
source dependency を使う場合、`BUILD_TESTING=ON` は tlvdemux の統合テストを
ビルドしますが、libaribtlv リポジトリ内部のテスト実行ファイルは取り込みません。
それらは libaribtlv 自身の CI で実行します。

release 前には unit suite に加えて、local に保存した全 sample の inventory gate を
実行します。

```sh
npm run test:inventory-samples
npm run test:inventory-samples:hardware  # macOS VideoToolbox
```

software gate は repository root と `demo/` にあるすべての `.tlv`／`.mmts`／`.mmt`
file に明示的な manifest entry を要求します。登録済みの各 sample について source の
同一性、16 MiB 上限の duration probe、上限付き WASM／MSE playback entry、全 file の
WASM／index scan を検証します。また、subtitle、layer selection、manual から automatic
への復帰、降雨起動／全 sample、および 60／200／380 秒 seek の各 contract を、それを
所有する sample で実行します。macOS gate は全 sample を native MSE／VideoToolbox で
hardware decode し、降雨 fallback 全体と `8k.mmts` の決定的な 16 landing seek probe も
実行します。回帰を割り当てずに保存 sample を追加または置換した場合は release gate を
失敗させます。これらの大容量 local capture は通常の package `npm test` には含めません。

共有ライブラリはデフォルトで有効です。Linux では `libtlvdemux.so.0`
（およびバージョン付きの実体ファイル）、macOS では対応する
`libtlvdemux.0.dylib` が生成されます。静的な `libtlvdemux.a` が必要な場合は
`-DBUILD_SHARED_LIBS=OFF` を指定してください。公開インターフェースは C++20 ABI
なので、動的リンクする利用側でも互換性のあるコンパイラーと C++ 標準ライブラリを
使用してください。

`add_subdirectory()` でプロジェクトに組み込む場合、コマンドライン実行ファイルは
`-DTLVDEMUX_BUILD_TOOLS=OFF` で無効化できます。テストは CMake 標準の
`BUILD_TESTING` オプションに従います。

tag 付き GitHub Release では、対応 platform ごとに単体で動作する
`tlvdemux-PLATFORM-ARCH`（Windows は `.exe` 付き）を配布します。download 後は
`tlvdemux` に rename し、Unix では実行権限を付けてください。利用者向けの各機能は
subcommand になっています。

```sh
tlvdemux --help
tlvdemux probe recording.mmts
tlvdemux inspect --list recording.mmts
```

この統合実行ファイルは、従来 install されていた `tlvdemux-pipe`、
`tlvdemux-probe`、`tlvdemux-inspect`、`tlvdemux-extract`、`tlvanalyze` を
置き換えます。既存 script では `tlvdemux` の後に対応する subcommand を追加してください。

macOS では、ブラウザーを起動せずに VideoToolbox probe でブラウザー向け MSE
経路のネイティブ部分を検証できます。この probe は MMTS を実際の
`MseRemuxer` に入力し、Chromium 互換の coded-frame discontinuity／RAP 規則を
適用して、`tfdt`／`trun` の連続性と HEVC サンプルフラグを検証し、ハードウェア
VideoToolbox デコーダーへ渡します。`SourceBuffer` 描画は別の統合境界であり、下記の
直接降雨復旧 contract はブラウザーの起動・自動化なしで受け入れ確認します。

次のコマンドは、境界サンプルで 4K から降雨対応映像・音声への自動切替を
検証します。

```sh
./build/tlvdemux-videotoolbox-probe \
  demo/rain.tlv \
  --mse --video-packet-id 0xf300 --audio-packet-id 0xf310 \
  --fallback-video-packet-id 0xf301 --fallback-audio-packet-id 0xf314 \
  --expect-rainfall-init --max-au 30000 --inflight 8
```

次の例では、サンプルを 3 倍速で送りながら、決定的なランダムバイト位置からの
再生を 16 回繰り返します。
この開発者向け probe は source build で利用でき、単一ファイルの Release には含まれません。

```sh
./build/tlvdemux-videotoolbox-probe demo/8k.mmts \
  --mse --rate 3 --inflight 4 --max-au 90 \
  --random-seeks 16 --seed 20260731
```

ライブラリ、公開ヘッダー、CMake ターゲット定義は次のようにインストールします。

```sh
cmake --install build --prefix /desired/prefix
```

共有または静的ライブラリ、公開ヘッダー、CMake パッケージターゲット
`tlvdemux::tlvdemux`、有効な場合は `tlvdemux` 実行ファイル、および MIT ライセンスが
インストールされます。

`MseRemuxer` は通常／降雨の A/V レイヤーを、連続 DTS、観測済み RAP、利用可能な AAC、
および明示的な source-damage 区間から独立に追跡します。自動再生の mode は通常と降雨の
2 つだけです。現在のレイヤーが損傷したとき、もう一方に同一 timeline 上の decode 可能な
映像・音声が揃っていれば core が切替を開始します。揃っていなければ現在のレイヤー向けに
`PlaybackDamage` を通知します。2 秒の severe 閾値未満で明示的な復旧 RAP がある区間は
`warning`／`seek-if-stalled` とし、parser の先読みでは復旧を準備するだけで media clock を
変更しません。復旧済みの severe 区間は従来どおり `severe`／`seek`、復旧 RAP がまだない区間は
RAP 到着まで `wait-for-recovery` とします。損傷を EOF まで保留せず、
観測していない区間の損傷を推定しません。降雨再生中も通常 tracker は更新され、caller が報告した
実際の再生位置に連続 5 秒の decode 可能な基線と整列した RAP/AAC が揃えば通常へ戻ります。
parser や録画 index の前進は再生時計ではありません。再生位置が timestamp 0 のままなのに数百秒先の
通常 media を読んだことを理由に降雨 media を置換してはいけません。再生位置が報告されるまでは
降雨→通常の自動復帰を準備状態のままにし、commit しません。降雨レイヤー自身の損傷も
同じ規則を逆方向に適用します。
通常から降雨への緊急切替は起動時も対象です。選択中の通常 layer が decode 可能な MSE 映像入口を
まだ出力しておらず、降雨 layer に実 RAP、その後の連続映像 DTS、連続 AAC、整列した A/V 境界が
揃った時点で、core は `health-degradation` 理由で直ちに切り替えます。要求する最早時刻は現在の
再生入口（録画の fresh 起動では timestamp 0）なので、cache 済み映像履歴は最後に観測した RAP
ではなく最初の利用可能な降雨 RAP から選びます。通常 layer の後続 damage event も 5 秒の healthy
基線も待ちません。この基線は、正常に降雨再生している間に通常へ自動復帰する判断だけに適用します。

`onMseLayerSwitchStarted`、`onMseLayerSwitch`、
`onMseLayerSwitchCancelled` は一回限りの A/V splice staging を表し、独立した復旧状態機械は
構成しません。SourceBuffer mutation は remove → timestamp offset → `changeType` →
init segment → media の単一 queue 順序で行います。既存 SourceBuffer に対するすべての構成
splice は対象の音声／映像 track ごとに独立して記録し、次の対応 init では MIME 文字列が同じでも
必ず `changeType()` を実行します。layer 切替は両 track、content 内の AAC channel layout または
HEVC SPS／color 構成の変更は該当 track だけを再設定します。
`demo/mpegts` の `82,837,220` bytes regression は映像 packet `0xf300` 内の SDR→HDR content
transition であり、選択 layer の損傷を示すものではありません。新しい `0xf300` decoder／color
構成を適用する間も再生は `0xf300` に留まり、降雨対応 packet `0xf301` を選択してはいけません。
同じ境界では選択音声 `0xf310` も 6ch から 2ch へ変化します。どちらも既存 SourceBuffer 上で継続し、
降雨 layer 切替や `16.168s` の持続的な `waiting` を発生させてはいけません。
MediaElement の `waiting` または後方の buffered range だけでは seek を許可しません。現在再生中の
layer に対する `PlaybackDamage.action === "seek"` だけが直ちに位置変更でき、
`seek-if-stalled` は許可として保持し、因果関係が成立する `waiting` だけが実行できます。遅延した
event は現在の media clock 以上にある buffer 済み parser 観測 RAP を使用できます。明示 PID または
具体的な track 選択は固定 mode のままで、自動 layer 判断を無効にします。
最初の利用可能な切替先 RAP で両 track を同じ境界に論理 splice し、その境界より後に
append 済みの旧 layer 音声を remove して、新しい AAC を 22 ms 以内の同じ境界へ写像します。
旧音声の先行 buffer を理由に映像切替を後続 RAP まで延期してはいけません。起動切替が通常映像
SourceBuffer の作成前でも、staging 順は論理映像 splice → 降雨 init → 降雨 media とし、存在しない
SourceBuffer には remove を行いません。破棄された staging の再試行は MIME が同一でも切替先 init
を含む完全な順序を再構築します。

timestamp 0 から録画を fresh 起動するとき、起動処理と後方 buffered range は
`MediaElement.currentTime` を代入してはいけません。位置変更を許可するのは user の明示 seek、
layer 切替が不可能だった後の選択中 layer に対する `PlaybackDamage.action === "seek"`、
`seek-if-stalled` が許可し、実際の提示 frame 証拠と対応する `waiting`、または既存の live 起動
policy だけです。
demo は位置変更を行わず、その media clock を復帰判断用に core へ報告します。

fresh recorded の SourceBuffer pair を作成する前に、demo は
`createMseOutputPipeline()` の atomic entry alignment を有効にします。pipeline は両 track の init と
最初の media segment を staging し、最初の共通 A/V source 区間を検出して、その先頭を timestamp 0
へ写像する同一の負の `timestampOffset` を両 SourceBuffer に設定してから、各 queue を
timestamp offset -> init -> media の順に commit します。降雨 layer の startup mapping など、明示的に
staging 済みの splice offset がある場合は必ずそれを優先し、entry alignment で別の offset を推導したり
加算したりしてはいけません。Live、明示 seek、MediaSource 再利用 path ではこの fresh-entry mode を
有効にしません。そのため、両 track の後方 range がまだ timestamp 0 に写像されていないことだけで
`MSE_STARTUP_NO_COMMON_AV` を即時に返してはいけません。fresh startup が失敗するのは、既存の 16 MiB
input budget 内で共通 A/V entry を形成できなかった場合だけです。
fresh playback の入口より最初の降雨 RAP が後にある場合、splice は RAP の source PTS を維持しつつ、
replacement A/V 出力を timestamp 0 へ写像する負の MSE timestamp offset を通知します。demo は同じ
SourceBuffer mutation queue で replacement init／media より前にこの offset を適用します。入力の
backpressure は parser の進捗ではなく共通 A/V buffered 区間を使用し、15 秒 ahead で request を止め、
8 秒未満で再開します。再生入口を覆う共通区間がない間は、進捗なしに読み込める playback input を
16 MiB に制限し、使い切った場合は録画を EOF まで取得せず `MSE_STARTUP_NO_COMMON_AV` で失敗します。

Live 再生には timestamp 0 の入口はありません。起動入口は現在の stream が生成した最初の共通
A/V buffered 区間であり、設定した live 起動 buffer が成立した後だけ media clock をその区間へ
合わせます。flow control は、この位置合わせが書き込まれる前から後方の共通区間を正常な入口として
受け入れ、その長さを測定しなければなりません。正常な live A/V が timestamp 0 を覆わないことを
理由に失敗させてはいけません。live A/V が共通区間を一つも形成できない場合は、同じ 16 MiB の
進捗なし上限で入力を停止し、`MSE_STARTUP_NO_COMMON_AV` を返します。

録画の明示 seek は別の public playback-entry contract です。head discovery、すべての RAP probe、
正式な A/V preroll は `createMseRecordedSeekSession()` の単一 16 MiB source-read budget を共有します。
probe と landing が重なる範囲は再利用し、budget 消費後は source request を発行しません。要求時刻より
前の RAP は正常な preroll であり、共通 A/V buffered 区間が user の要求時刻を覆うまで seek を継続し、
その後だけ通常の 15 秒停止／8 秒再開 backpressure へ移行します。probe は target + 50 ms までの RAP
だけを記録し、観測済み候補の解析前縁が target を越えた時点で停止して、未観測 layer を待たず target
より後でない最も近い RAP を選択します。正式 landing では一度だけの reposition の直後、landing input
を一つも渡す前に、session は元の source target を一回限りの recorded-seek concealment target として
HEVC remuxer へ渡します。その target が選択映像の
source-damage episode 内にある場合だけ、既存の stable-GOP 検証後に静止画で穴を埋めます。損傷前の
完全な最終 sample があればその duration を stable RAP の decode boundary まで延長し、landing 内に
前画面がなければ stable RAP の先頭 frame を target に複製します。この場合も元の RAP は元の DTS/PTS
に残し、AAC は元の連続 timeline を維持します。この填補は `MediaElement.currentTime` を変更せず、
追加 landing seek、source の再 scan、単一 16 MiB budget の増加を行いません。したがって生の共通 A/V
が target より後だけ、または非交差でも、填補によって exact target の共通 coverage が形成されれば
正常です。利用可能な損傷前 frame も安定後続 RAP もない場合、RAP なし、EOF、填補後も A/V が非交差、
または budget 消費の場合は `MSE_SEEK_NO_COMMON_AV` で読み込みを停止します。これを
`MSE_STARTUP_NO_COMMON_AV` として報告したり、MediaElement の hidden seek や録画全体の scan に
fallback してはいけません。

自動の 2 映像 track を持つ録画では、public な録画 timeline は通常映像と降雨映像の
presentation range の和集合です。録画開始はより早い最初の映像 frame、録画終了はその
track の推定最終 frame duration を含むより遅い最後の映像 frame とし、public duration は
`end - start` です。media time 0 はこの和集合の開始に対応し、もう一方の映像 layer は同じ
origin からの本来の offset を維持します。duration 表示、`MediaSource.duration`、fresh startup、
録画の明示 seek、選択 layer の damage recovery、および MSE timestamp offset はすべてこの
単一 mapping を使用します。明示的な `videoPacketId` は範囲をその一つの映像 track に制限します。

選択 layer の自動 recovery は録画の明示 seek とは別です。現在 layer の severe な
`PlaybackDamage.action === "seek"` が具体的な recovery timestamp を持つ場合は、同じ
和集合 origin mapping で media clock を一度だけ変更できます。復旧済みの短い `warning` は
`seek-if-stalled` とし、登録時には位置変更せず、その損傷へ media clock が到達した後の `waiting`
一回につき最大一度だけ実行できます。`MediaElement.currentTime` と `playing` は損傷映像の decode 成功を
証明しません。音声だけで media clock が最初の復旧 RAP を越えても、表示映像は停止したままに
なり得ます。SDK は `requestVideoFrameCallback()` で compositor に実際に提示された映像 PTS を
追跡し、提示済み frame が最初の復旧 RAP 以上なら許可を破棄します。そうでない遅延 `waiting` は、
現在の media clock 以上にある parser 観測済み RAP のうち、buffer 済みの最初の点を選びます。
RAP が未到着または未 append の場合は access unit／SourceBuffer の前進まで許可を保持します。
この復旧は必ず前方へ進み、通過済み RAP へ後方 seek してはいけません。この状態機械は public な
`tlvdemux/mse-playback` SDK に置き、demo は media／layer callback、parser RAP、`waiting`、
SourceBuffer の前進を転送するだけにします。提示 frame callback がない browser は安全な従来 subset
として、media clock が最初の復旧 RAP を越えていない場合だけ復旧できます。どちらも duration probe
の再実行、source scan、A/V layer switch との並行実行は禁止します。parser 観測済み RAP を伴わない
buffered range、非選択 layer の damage、通常の `waiting`、`wait-for-recovery` だけでは seek を許可しません。

選択映像が、parser で観測した相異なる厳密前方の実在 recovery RAP を 3 回試しても新しい frame を
提示できない場合、public playback resilience controller は安定 code `TLV_VIDEO_UNAVAILABLE` とともに
`audio-only` へ入ります。これは `audio-video`、`recovering-video`、`restoring-video` と並ぶ独立 mode で、
`PlaybackDamage.action` や severity threshold は変更しません。現在 layer の damage authorization、各 RAP
試行後の因果関係がある `waiting`、新しい提示映像がないことのすべてを必須にします。通常の waiting、
user pause、明示 seek、layer／audio track 切替、古い generation、非選択映像の damage では audio-only に
してはいけません。
integration は visible MediaElement の `pause`／`play` lifecycle を
`notifyPlaybackPaused()`／`notifyPlaybackResumed()` へ明示的に通知します。pause は current damage
episode、stable RAP、既存の試行記録を消さず、waiting 消費、recovery RAP 試行、audio-only 判定、restore
commit を凍結します。resume は凍結を解除するだけで、復旧は新しい因果 `waiting` または新しく実提示された
video frame の後にのみ続行できます。pause 前の waiting／buffer event を持ち越してはならず、damage recovery
から visible MediaElement の `play()` を呼んではいけません。

audio-only 中は MSE の required track set を audio に変更し、startup、buffer coverage、backpressure、
recorded-seek landing は video SourceBuffer を待ちません。非 active video output は即時破棄し、無制限の
transition cache を作りません。runtime の in-place 切替は video SourceBuffer が実際に
`activeSourceBuffers` から外れたことを観測した場合だけ成功とし、それ以外は新しい audio-only
MediaSource を構築します。録画 rebuild は public index／seek session と一つの 16 MiB read budget を
再利用します。録画 rebuild は resource transaction です。旧 MediaSource は現在の audio、media clock、user の
play／pause 意図を保ったまま attach され続け、cached duration／index から bounded hidden candidate を
構築します。audio-only candidate は target の audio が buffer 済みになった場合、A/V candidate はさらに
restore RAP の実提示が証明された場合だけ promote できます。pause 中は candidate buffer を保持できますが、
candidate の再生と commit は禁止します。open、format、seek、append、decode のどの失敗でも candidate
だけを破棄し、旧 MediaSource を detach、stop、seek、変更してはいけません。
Live は replacement audio pipeline が再生可能になるまで現在 input を有界に保持し、再接続や既存 audio
pipeline の停止を行いません。transition 中の正準 clock は常に audio です。
`createLiveMseTransitionManager()` は 4 MiB 上限の candidate MediaSource queue を所有し、active pipeline
と同じ継続中 demux output を受け取ります。復旧 A/V candidate は probe MediaElement が target frame を
`requestVideoFrameCallback()` で報告した場合だけ commit します。commit は attachment を維持した candidate
MediaElement 自体を昇格します。object URL を detach／reattach すると MSE detach algorithm が両
SourceBuffer list を空にするため禁止します。

audio-only 再生中は audio clock より厳密に後の各実在 RAP を一度だけ restore 候補にできます。共通 A/V
candidate が buffer 済みとなり、`requestVideoFrameCallback()` がその RAP 以後の frame の実提示を証明する
まで `restoring-video` を維持します。candidate failure は現在の audio 再生を残して `audio-only` へ戻り、
後続 RAP を待ちます。同じ RAP の再試行、後方 seek、user pause を上書きする `play()` は禁止します。
明示 seek、track／layer 選択、generation replacement、source end は transition を中止します。demo は
固定された video-stage slot に SDK の structured mode を表示し、retry count や timer を見せず、
「映像を復旧できないため、音声のみ再生しています。利用可能になり次第、自動的に戻ります。
[TLV_VIDEO_UNAVAILABLE]」と表示します。

復旧可能な AAC source-damage marker は、既に queue 済みの audio を捨てたり、選択 audio の
fragment timeline を再開始したりしてはいけません。欠落 AAC frame は次の 1024-sample 境界へ
詰め、後続 fragment を連続させます。そうしない場合、映像が buffered 済みでも Chromium は
`DEMUXER_UNDERFLOW` を報告し、共通 A/V buffer がほぼ 0 のままになります。captured sample
`20260828-101-021500_8deb3dd2-39e9-471c-a9ba-a6dfe23feeb6.mmts` は、繰り返す audio
discontinuity marker があっても audio buffering が前進することを検証します。

Worker client は public API に渡されたすべての `Uint8Array` を caller 所有として扱います。
`TlvDemuxer.push()`、duration probe の `pushRange()`、`setMseEdid()` は SDK 所有の copy だけを
transfer し、caller の `ArrayBuffer` を detach してはいけません。特に明示 seek は、detached
`ArrayBuffer` error や追加 seek を起こさず、probe と landing の間で cache 済み source bytes を
再利用できなければなりません。

`rain.tlv` の検証では、最初の自動切替を最初の降雨 RAP（現在約 `821944us`）で要求し、通常 layer
の init、後続する約 46 秒の通常 damage event、あらゆる seek より先に完了させます。最初の切替先
source 境界は `821944us` のまま、startup timestamp offset により最初の共通 MSE A/V 区間を
timestamp 0 へ写像します。最初の init は `1920x1080/L123`、全 sample WASM 実行には
`PlaybackDamage.seek` がなく、切替 A/V 境界差は AAC 1 frame の 22 ms 以内でなければなりません。
startup flow-control は 16 MiB の進捗なし budget 内で共通区間へ到達し、通常 prefetch は 15 秒の
high-water mark で停止して 711 MiB sample を EOF まで取得してはいけません。従来の 0:48 付近の切替と `-12909` は正常な切替点
ではなく、今回修正する失敗です。この復旧 path の自動 acceptance は native VideoToolbox MSE probe
と全 sample WASM assertion だけで行い、browser automation を起動せず、user を最初の runtime
tester にしません。

単一 layer の captured sample
`20260828-141-020000_99332dc9-025e-4e76-afc4-e31c3d577059.mmts` は正確に
`1792861104` bytes、`496.913089` 秒で、映像 packet `0xa140` と音声 packet `0xa141` だけを含み、
降雨 fallback はありません。全 sample regression では、選択映像の短い損傷を完全な source 区間、
input offset、実在する復旧 RAP とともに `seek-if-stalled` として公開しなければなりません。
parser の先読みでは seek しません。実 browser では最初の写像済み復旧 RAP `6.272934s` より遅い
`6.580s` 付近で `waiting` が発生し、表示映像はまだ復旧していません。このとき SDK は次の
parser 観測済み前方 RAP `6.806806s` を選び、buffer 済みになった後に一度だけ seek して再生を
継続しなければなりません。古い候補や無関係な `waiting` は前後どちらにも seek してはいけません。
実 browser acceptance では、降雨切替、MediaSource 再構築、recorded-seek session、source 全体の
再読込なしに、この自然な遅延停止から継続することを確認します。

復旧 RAP へ `MediaElement.currentTime` を代入しただけでは、短い損傷の復旧を完了としません。
compositor が最初の復旧 RAP 以上の frame を実際に提示するまで許可を保持します。その後も因果関係の
ある `waiting` 一回につき、厳密に前方にある parser 観測済みかつ buffer 済みの RAP を最大一つだけ
使用でき、parser／SourceBuffer の前進だけで復旧点を連続 seek してはいけません。この sample で
観測済みの第二境界は、`13.245s` の `waiting`、`13.747079s` への最初の試行、そして最後に提示された
映像 frame が `7.291s` のまま発生する `13.747s` の再度の `waiting` です。この二回目の event でも
同じ損傷許可を保持し、`13.747079s` を繰り返さず、次の実在 RAP `14.280934s` へ進まなければ
なりません。実際に復旧 frame が提示された場合だけ許可を完了し、以後の無関係な `waiting` による
seek を禁止します。

同じ sample で観測された media time `101.810s` の `waiting` は通常 waiting です。その clock に
selected-video damage はなく、parser が先読み済みの future damage は mapped media time
`114.097s` に始まり、実在 RAP `115.315189s` で復旧します。この damage は future boundary まで
保持し、`101.810s` で seek や audio-only を許可してはいけません。demo diagnostics は source PTS を
現在の MediaElement clock と並べず、mapped playback time と先読みであることを表示します。

MediaElement が SDK 所有の復旧 target に対してまだ `seeking` を返している場合も同じ規則です。
観測済みの `6.589s -> 6.806806s -> 7.340679s` の試行では、`seeked` より先に因果関係のある
`waiting` が `7.341s` で再度発生します。media clock が最後の SDK 試行と一致し、提示映像が最初の
復旧 RAP より前のままなら、この event は次の実在 RAP `7.874540s` へ進めなければなりません。
許可された recovery seek は recovery target を書くだけで、visible MediaElement の `play()` を呼びません。
play／pause intent は browser に既に設定された user intent が所有し続けます。
無関係な target に対する `seeking` は引き続き復旧を許可しません。

許可された各復旧 seek は、`currentTime` 更新前の MediaElement の再生意図を保持し、再生中だった
場合は更新後に browser が `paused` を返しても再生を再開しなければなりません。手動の再生クリックが
必要な状態は自動復旧の成功ではありません。user が実際に pause した MediaElement、または対応する
選択映像の損傷許可がない通常の `waiting` は再生を開始してはいけません。

復旧には、損傷境界の後にも decode 可能な MSE media が必要です。選択映像の source-damage marker
では、欠落前の完全で正常な映像 sample を確定して出力し、既存の source timeline mapping を保持します。
最初の実在 RAP から有界の観察期を開始してその GOP を捨て、次の source-damage marker が候補を否決し、
損傷のない GOP 一つを通過した次の実在 RAP からだけ映像出力を再開します。候補 GOP は cache しません。
権威 sample の `99.201500–99.351650s` と `99.468433–99.485117s` の孤島を出力してはならず、AAC を
連続させたまま source PTS `100.269228s` から安定出力を再開します。startup、明示 seek、track／layer
切替、および無損傷入力は従来どおり最初の RAP から開始します。
観察期を有効にするのは、選択映像の現在 generation がすでに media を受理した後だけです。fresh
startup の source-damage marker は最初の RAP 自身に付いている場合も、別の無損傷 GOP を待たずその
最初の実在 RAP から開始し、同じ 16 MiB の進捗なし budget 内で初回共通 A/V entry を形成します。

手動から自動への layer 選択変更は policy flag だけではなく、能動的な遷移です。user が降雨対応
layer を手動選択している場合、自動選択を有効にすると preferred／fallback A/V pair を設定し、次の
利用可能な RAP で、保持した health 観測により正常と判定された preferred video と対応 audio へ
直ちに協調復帰しなければなりません。preferred layer が利用不能または破損中なら、EOF まで pending
switch を残さず利用可能な降雨対応出力を維持します。自動 mode の再有効化は未完了の手動 request も
置き換えます。最初の共通 A/V entry が成立する前の手動 layer 選択は replacement の映像と音声を
その playback entry へ写像し、正常な preroll を `MSE_STARTUP_NO_COMMON_AV` として報告しません。

## ライブラリの使い方

残る共通 browser playback behavior を public SDK へ移す段階的な計画は
[Browser playback SDK 集約計画](docs/browser-sdk-roadmap.ja.md) に記載しています。

browser integration は demo の probe logic を複製せず、録画 seek coordinator を import します。

```js
import {createMsePlaybackFlowControl, createMseRecordedSeekSession}
  from 'tlvdemux/mse-playback';

const flowControl = createMsePlaybackFlowControl({
  media, queues, entryKind: 'seek', entryTimeSeconds: targetSeconds,
});
const seek = createMseRecordedSeekSession({
  targetTimeSeconds: targetSeconds,
  source, durationUs, demuxer, media, queues, flowControl,
  headReady: () => selectedVideo !== null,
});
callbacks.onTrack = track => seek.observeTrack(track);
callbacks.onTrackRemoved = track => seek.observeTrackRemoved(track);
callbacks.onAccessUnit = unit => seek.observeAccessUnit(unit);
const {nextOffset} = await seek.run();
```

coordinator は同期 native-WASM method と Promise を返す worker wrapper の両方を受け入れるため、
DPlayer adapter も同じ lifecycle を利用できます。

`aribtlv::Sink` を実装し、demuxer の生存期間中はそのインスタンスを保持して、
任意のサイズに分割したデータを同期的に入力します。

```cpp
#include <aribtlv/demuxer.hpp>

class PlayerSink final : public aribtlv::Sink {
public:
    void onService(const aribtlv::ServiceInfo& service) override;
    void onTrack(const aribtlv::TrackInfo& track) override;
    void onAccessUnit(aribtlv::AccessUnit&& unit) override;
    void onError(const aribtlv::Error& error) override;
};

PlayerSink sink;
aribtlv::Demuxer demuxer(sink);
demuxer.push(data, size);
demuxer.flush();
```

`push()` は入力ポインターを保持しません。コールバックの payload は自身でデータを
所有します。不正なストリームデータは `onError()` で通知され、復旧可能な場合は
解析を続けます。入力ストリームを切り替える際は `reset()` を呼び出してください。
サービスとトラックの選択方針は維持されます。

音声トラックは、通知されたチャンネル構成、component type、main-component flag、
sample rate を含む MH audio component metadata を `TrackInfo::audio` で公開します。
番組をまたいで packet ID が固定されていると仮定せず、この metadata からトラックを
選択してください。

### Demuxer のライフサイクル

demuxer の各 instance は、1 つの論理的な input session として扱います。以下の操作は
parser を消去する別名ではなく、それぞれ異なる境界を表します。

- `push()` は任意の chunk 境界を受け付けます。native callback および直接利用する
  WASM の media／signalling callback は、この呼び出しの中で同期的に実行されます。
  callback-lifetime の byte view は、`push()` が戻る前に消費してください。直接利用する
  WASM では、後述のとおり application-resource assembly は別の queue で処理します。
- `flush()` は現在の連続した input 区間を閉じます。完成した buffered access unit を
  出力し、不完全な fragment を通知して破棄します。その後に media を入力すると
  discontinuity から再開し、video は RAP を待ちます。demuxer の破棄、検出済み
  metadata の消去、recording index の finalize、`MediaSource.endOfStream()` は行いません。
  実際の EOF または意図した input 境界で呼び、live の network read が一時的に空に
  なっただけでは呼び出さないでください。
- `reposition(offset, true)` は同じ source 内での seek です。track selection と正規化済み
  media timeline を維持し、`offset` を新しい絶対 input position として使用します。
  選択された video の RAP を待ち、各 track の最初の output を discontinuous にします。
  新しい位置を timeline の新しい原点にする場合だけ `false` を指定してください。
  WASM wrapper では、完成済みの application VFS file は維持され、不完全な carousel
  assembly だけが破棄されます。
- `reset()` は論理的な source の交換です。parser、service／track catalogue、timeline、
  application resource、offset、error counter は消去されますが、明示的な service／track
  selection と生成時の option は維持されます。有効な WASM recording index は空の状態で
  再開されます。交換後の source で track ID が異なる場合は、維持された ID を解除するか
  選び直してください。
- `selectService()` は service session の変更であり、media seek ではありません。
  service に属する track、timing、application resource を消去するため、その後の
  `onTrack` callback から新しい track を選択してください。
- 永続的な EOF では `flush()` を呼び、indexing を有効にしている場合は続けて
  `finalizeIndex()` を呼びます。非同期の SourceBuffer／application consumer が空に
  なってから MSE を終了してください。WASM object は最後に `delete()` で解放する必要が
  あります。native code では `Sink` が `Demuxer` より長く生存する必要があります。

### ブラウザー用 MSE queue

ブラウザー統合では、append、trim、retry、worker backpressure の状態機械を player
ごとに複製せず、package に含まれる SourceBuffer queue を利用できます。

```js
import {
  MseAppendQueue,
  finalizeMseMediaSource,
} from 'tlvdemux/mse-append-queue';

const videoQueue = new MseAppendQueue(mediaSource, video, videoMime);
videoQueue.append(initSegment);
videoQueue.append(mediaSegment);
await videoQueue.waitBelow(4 * 1024 * 1024);

await finalizeMseMediaSource(mediaSource, [videoQueue, audioQueue], {
  // demuxer が物理的に不完全な input tail を通知した場合だけ有効にします。
  truncateToCommonEnd: incompleteInputTail,
});
```

queue は pending と append 中の byte をともに数え、`updateend` ごとに所有 byte 数を
再計算します。`appendBuffer()` と `remove()` を直列化し、Chromium の quota pressure
を自動で trim／retry し、切り離された、または失敗した SourceBuffer をエラーとして
扱います。finalizer は両 track が空になるのを待ってから `endOfStream()` を呼びます。
物理的に切れた input の場合だけ、対応する音声のない映像末尾などを先に除去し、最後の
共通 coded frame で安全に終了できます。不正 input の error を隠したり、完全な録画を
短くしたりはしません。

## データ放送アプリケーションと仮想ファイル

アプリケーションリソースの収集はデフォルトで有効です。demuxer はメディアの
アクセスユニットを出力しながら、application signalling、data-directory table、
asset-management table、および順不同で届く data unit を完全なファイルへ
組み立てます。`Sink` には `onApplicationState`、`onApplicationResource`、
`onApplicationResourcesReset` イベントが届きます。AIT の entry path が存在すると
アプリケーションは `Ready` になりますが、参照先のほかのファイルはその後も放送
carousel から到着する場合があります。

resource の収集状態と、放送側が要求する application lifecycle は互いに独立しています。
`state` は仮想 file の利用可能性を表します。`ready` は entry document が存在するという
意味であり、参照先の全 resource が揃ったことや HTML runtime が起動したことを意味
しません。`lifecycle` は AIT の `controlCode` を次のように変換します。

| `controlCode` | 通知される `lifecycle` | receiver の責務 |
| --- | --- | --- |
| `0x01` AUTOSTART | entry が届くまでは `autostart-pending`、到着後は `autostart-ready` | ready になり、receiver policy が許可した後にだけ起動します。 |
| `0x02` PRESENT | `present` | application を提示可能にします。実際に起動したことを示す状態ではありません。 |
| `0x04` KILL | `killed` | 実行中の runtime／session を停止します。resource reset までは cached file が残る場合があります。 |
| `0x05` PREFETCH | entry が届くまでは `prefetching`、到着後は `prefetched` | application を提示せず、resource の収集／cache だけを行います。 |
| その他 | `unsupported` | 起動操作を推測しません。 |

`tlvdemux` はこれらの遷移を通知しますが、application runtime 自体の起動、reload、終了は
行いません。冪等な start／stop、UI policy、security boundary を含む state machine は
host が所有します。WASM API では `reset()` と `selectService()` が完成済み VFS を消去して
`onApplicationResourcesReset` を通知し、`reposition()` は完成済み file を意図的に維持
します。このため、host が停止するか resource session が reset されるまで、`killed` の
application が同時に `state: "ready"` である場合もあります。

WASM を直接利用する場合は、application assembly も明示的に進める必要があります。
input batch の後に `drainApplicationResources(maxEvents)` を呼び、`true` が返った場合は
次の drain を schedule してください。`0` を指定すると、その時点で queue にある event
をすべて処理します。`flush()` の後は、final VFS を読み取るか demuxer を削除する前に、
`false` が返るまで drain してください。demo の worker wrapper はこの scheduling を
自動で行い、大きな carousel の展開が media input を塞がないようにしています。

完成した byte 列は demuxer 内に無期限で保持されず、sink へ move されます。
ネイティブのホストでは、thread-safe な `ApplicationResourceStore` に保存できます。
その `get`、`list`、`waitFor` は loopback HTTP／WebView adapter での利用を想定して
います。

```cpp
class ReceiverSink final : public aribtlv::Sink {
public:
    aribtlv::ApplicationResourceStore files;

    void onApplicationState(const aribtlv::ApplicationState& state) override {
        files.onApplicationState(state);
    }
    void onApplicationResource(aribtlv::ApplicationResource&& resource) override {
        files.onApplicationResource(std::move(resource));
    }
    void onApplicationResourcesReset() override {
        files.onApplicationResourcesReset();
    }
    // 通常どおり、必須の media/error callback 4 個も実装します。
};
```

store 自体は socket や HTTP に依存しません。ネイティブアプリケーションは別の
server を `127.0.0.1` に bind し、`files.waitFor(context_id, path, timeout)` で
request に応答できます。WASM の利用側では通常、同じイベントを JavaScript の
`Map` に保持し、Service Worker 経由で公開します。

リソース収集は `Limits::collect_application_resources` で無効化できます。
`Limits` は pending item の個数／byte 数、catalogue size、展開後の file size にも
上限を設けるため、不正な carousel によってメモリーが無制限に増加することは
ありません。

## FFmpeg へ pipe する

`tlvdemux pipe` は、最初に一致した HEVC 映像と AAC-LATM 音声を、seek 不要の
fragmented MP4 として stdout へ remux します。診断は stderr のみに出すため、
そのまま FFmpeg に接続できます。

```sh
./build/tlvdemux pipe recording.mmts |
  ffmpeg -f mp4 -i pipe:0 -c copy output.mp4

curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  ./build/tlvdemux pipe - |
  ffmpeg -f mp4 -i pipe:0 -c:v copy -c:a aac output.mkv
```

自動選択された最初の track が目的の番組でない場合は、`--service ID`、
`--video-packet-id ID`、`--audio-packet-id ID` を指定します。映像と音声の codec
configuration が両方届いてから出力を開始します。pipe には拡張子がなく、放送から
初期化情報が届くまで時間がかかる場合があるため、`-f mp4` の明示を推奨します。

サムネイル抽出など映像だけを使う場合、`--video-only` は音声を待機・remux せず、
映像1 track の fragmented MP4 を出力します。

```sh
./build/tlvdemux pipe --video-only recording.mmts |
  ffmpeg -f mp4 -skip_frame nointra -i pipe:0 -frames:v 10 -f null -
```

有限個の frame を受け取った consumer が pipe を閉じた場合、`tlvdemux pipe` は stdout
の切断を正常な consumer cancellation として扱います。`--video-only` と
`--audio-packet-id` は同時に指定できません。

## ストリームを調査する

```sh
./build/tlvdemux inspect --list test.tlv
./build/tlvdemux inspect --trace-au test.tlv
./build/tlvdemux inspect --video video.hevc --audio audio.loas \
  --subtitle subtitle.ttml test.tlv
./build/tlvdemux inspect --audio secondary.loas \
  --audio-packet-id 0xf311 test.tlv
./build/tlvdemux analyze test.tlv
```

`tlvdemux analyze` は録画全体を走査し、再構成した ARIB-HTML5 resource を一覧化します。
各 virtual file について path、MIME type、展開後 size と CRC32、carousel 上の
出現回数、完全一致した重複回数、および重複 payload byte 数を表示します。
重複判定では完全な wire payload を比較し、対応不明、discontinuity、または内容が
変化した unit は報告だけ行い、削除可能量には含めません。

検証用の入力を収録する際は、Mirakurun の raw 4K 経路を `decode=0` で使用します。

```sh
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' > test.tlv
```

ライブ入力の色基準を採取する場合、`scripts/compare_qvc_color.py` は QVC の
CS161（MPEG-TS service `700161`）と BS4K 221（MMT/TLV service `1100221`）を
同時に受信し、画面内容から時刻差を求め、既定で 10 分間のリニア光統計を記録します。

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux
```

放送ストリームとデコード済みフレームは保存しません。完全なプロセスログ、レポート、
小さい整列済み PPM preview は `color-comparisons/` 以下に保存します。CS は BT.709
SDR、BS4K は BT.2020 HLG としてデコードし、解析時だけ双方を linear BT.709 に
変換します。source baseline に被疑実装を混ぜないため、tlvdemux の SDR-in-HLG
rewrite と HLG-to-SDR LUT は適用しません。
QVC CS161 は低ビットレートの MPEG-2 service であり、BS4K の HEVC よりも
本質的にぼやけます。SDR の低周波輝度基準としてのみ使用し、BS4K の空間 detail や
局所的な色の豊かさを CS に合わせないでください。

現在の project SDR 出力を同じ基準で測定するには、明示的な candidate path を
選択します。厳密な HLG `9/18/9` 信号を `9/1/9` に rewrite し、C++ と同一の
8-bit 3D LUT を export して trilinear 補間で適用します。

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux \
  --bs-mode current-sdr
```

browser demo の受控 prototype と同じ `1/13/9` carrier と prototype LUT を測る場合は、
`prototype-sdr` を選択します。

```sh
python3 scripts/compare_qvc_color.py --tlvdemux ./build/tlvdemux \
  --duration 15 --fps 4 --max-offset 5 --snapshot-interval 5 \
  --bs-mode prototype-sdr
```

低 level tool も直接使用できます。

```sh
tlvdemux hlg-sdr-lut > current-hlg-sdr.cube
tlvdemux hlg-sdr-lut --prototype > prototype-hlg-sdr.cube
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  tlvdemux pipe --video-only --sdr-in-hlg - |
  ffmpeg -f mp4 -i pipe:0 -f null -
curl 'http://MIRAKURUN/api/services/SERVICE_ID/stream?decode=0' |
  tlvdemux pipe --video-only --hlg-sdr-prototype - |
  ffmpeg -f mp4 -i pipe:0 -f null -
```

`--sdr-in-hlg` は選択した video track に対する固定の明示設定です。browser demo の
display 依存 `auto` policy は CLI に持ち込みません。

同じ種類のトラックが複数ある場合、診断用 dumper は最初に検出した対応トラックを
書き出します。`--trace-au` では、引き続き出力されたすべてのトラックを表示します。

ライブラリは、必要な B61 descrambling が `Demuxer::push()` へ入力される前に
完了していることを前提とします。検証環境では、Mirakurun の `decode=0` が
MMT/TLV ストリームを維持しつつ、tuner/frontend 経路から利用可能な media payload
が渡されます。B61 message-authentication metadata は解析されるため、末尾に付加された
authentication code が media payload の一部として露出することはありません。
ただし、暗号学的な検証自体は呼び出し側の責任です。

## WebAssembly

npm から、ビルド済みの単一ファイル WebAssembly パッケージをインストールします。

```sh
npm install tlvdemux
```

パッケージは CommonJS から直接使用でき、ESM 対応 bundler で一般的な default import
interop にも対応します。

```js
import createTlvDemuxModule from "tlvdemux";

const module = await createTlvDemuxModule();
const demuxer = new module.TlvDemuxer({
  onTrack: track => console.log(track),
  onAccessUnitView: unit => consumeSynchronously(unit),
  onError: error => console.warn(error),
});
```

MSE プレーヤーでは、`mseMaxAudioChannels` によって、AAC の設定を書き換えずに
ブラウザー側の上限を超えるチャンネル構成を除外できます。たとえば `6` を指定すると
モノラルから 5.1ch までは維持し、22.2ch AAC の init segment は出力しません。
`onTrack` の `track.audio.channels` を使って、互換性のある別のトラックを選択して
ください。省略時または `0` の場合、remuxer はチャンネル数を制限しません。

#### BS8K の 22.2ch 音声を除外する

BS8K の番組によっては、AAC の `channel_configuration=13` で表される
22.2ch（24 チャンネル）音声が送出されます。Chromium 系ブラウザーはこの構成を
MSE で受け付けず、音声の `appendBuffer()` が MediaError になることがあります。
ブラウザー再生では次のように上限を 6 チャンネルにすると、モノラルから 5.1ch
までは通し、22.2ch の MSE init segment は出力しません。

```js
let selectedAudio = false;
const demuxer = new module.TlvDemuxer({
  mseMaxAudioChannels: 6,
  onTrack(track) {
    const channels = track.audio?.channels ?? 0;
    if (!selectedAudio && track.kind === "audio" &&
        (channels === 0 || channels <= 6)) {
      selectedAudio = true;
      demuxer.selectTrack("audio", track.trackId);
    }
  },
  onMseInit: init => appendInitSegment(init),
  onMseSegment: segment => appendMediaSegment(segment),
});
```

この設定は 22.2ch を 5.1ch にダウンミックスするものではなく、非対応の音声を
MSE に渡さないための安全策です。複数の音声トラックがある場合は
`track.audio.channels` を見て 5.1ch またはステレオの代替トラックを選択して
ください。省略時または `0` の場合、チャンネル数による制限は行いません。

module、callback、event、duration probe、recording index の TypeScript 型定義も
含まれます。npm パッケージには WebAssembly binary を埋め込んだ生成済み wrapper が
含まれるため、利用側に Emscripten は不要で、別の `.wasm` request も発生しません。

### HLG → SDR renderer

`TlvDemuxer.hlgSdrColorLut()` は、C++ の色変換実装から生成した packed RGB 3D LUT を
返します。`tlvdemux/hlg-sdr-renderer` から `HlgSdrRenderer` を import し、その LUT を
`setColorLut()` へ渡してください。WebGPU と WebGL は同じ三線形補間だけを行うため、
tone curve や色変換が JavaScript shader ごとに分岐しません。従来の
`hlgSdrToneMappingLut()` 1D API は互換性のため一時的に残しますが、新規 integration
では使用しないでください。`setMseToneMappingMode('on_compare')` は `force` と同じ
MSE 信令を使い、`HlgSdrRenderer.setComparisonEnabled(true)` で左半分を LUT 未適用、
右半分を LUT 適用として表示できます。

### iOS／iPadOS Safari

WASM demuxer 自体は、公開 API で使用する `BigInt` を含め、現在の iOS Safari で
動作します。ただし、player integration は標準の `MediaSource` constructor が
存在することを前提にできません。iOS では互換性のある `ManagedMediaSource` API が
公開されます。constructor を一度選択し、capability check と生成の両方で同じものを
使用してください。

```js
const BrowserMediaSource = globalThis.ManagedMediaSource || globalThis.MediaSource;
if (!BrowserMediaSource?.isTypeSupported(mime)) throw new Error(`Unsupported: ${mime}`);
const mediaSource = new BrowserMediaSource();
```

object URL を video element に設定する前に `sourceopen` listener を登録し、その後で
attach して再生を開始します。`demo/demo.js` はこの経路を実装しています。
`demo/ios-compat.html` は小さな feature／end-to-end 診断ページで、WASM、HEVC/AAC、
MSE/MMS、SourceBuffer の結果を個別に表示します。

iOS Simulator を ManagedMediaSource 再生の最終判断に使用しないでください。
WebKit bug 266764 では、Simulator が API を公開しながら source を open しない場合が
あると説明されています。SourceBuffer の段階は実機の iPhone／iPad で確認して
ください。WebKit の ManagedMediaSource integration example も参照してください。

- https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/
- https://bugs.webkit.org/show_bug.cgi?id=266764

### npm パッケージをビルドする

Emscripten で browser／worker 用 wrapper をビルドします。

```sh
nix-shell
emcmake cmake -S . -B build-wasm -G Ninja \
  -DBUILD_SHARED_LIBS=OFF -DTLVDEMUX_BUILD_TOOLS=OFF
cmake --build build-wasm --target tlvdemux-wasm
```

`nix-shell` 内で `npm run build` を実行すると、同じ release build を行い、生成物を
`dist/tlvdemux.js` へコピーします。`npm pack --dry-run` は release build と WASM
smoke test を行ってから、実際に公開されるファイルを表示します。

生成物は単独で完結する `build-wasm/tlvdemux.js` です。WebAssembly binary は
埋め込まれており、別の `.wasm` request は発生しません。通常の script として
読み込み、非同期に demuxer を生成します。

```js
const module = await createTlvDemuxModule();
const demuxer = new module.TlvDemuxer({
  onTrack: track => console.log(track),
  onEventInfo: event => console.log(event.title, event.startTimeUnixMilliseconds),
  onStreamEvent: event => console.log(event.eventMessageTag, event.messageId),
  onAccessUnitView: unit => consumeSynchronously(unit),
  onApplicationState: application => console.log(application.state),
  onApplicationResourceView: resource => console.log(resource.path),
  onError: error => console.warn(error),
});

demuxer.push(chunk); // Uint8Array; WASM memory にコピーされます
demuxer.flush();
demuxer.delete();
```

buffer を管理済みの loader では、`_malloc`、`_free`、`HEAPU8`、
`pushFromHeap(address, size)` により再利用可能な heap-buffer 経路を利用できます。
JavaScript では、64-bit の offset、timestamp、track ID を `BigInt` で受け取ります。
MH-EIT の current/following および schedule entry は `onEventInfo` で通知されます。
`tableId === 0x8b` かつ `sectionNumber` が 0／1 の event は、その service の
present／following event です。

ARIB STD-B60 の EMT message は `onStreamEvent` で通知されます。event には、
MPT で通知された EMT tag、group／id／version、private byte、raw time-mode field が
含まれ、receiver は demux／read-ahead clock ではなく playback clock に合わせて
timed message を発火できます。`rawMessageId` は B60 の 16-bit descriptor field を
保持し、その上位 octet は `messageId`、下位 octet は `messageVersion` として B62
application に公開されます。

`onAccessUnitView` は media output のコピーを省きますが、その `data` view は callback
の実行中だけ有効なので、同期的に消費する必要があります。callback の後も保持する
場合は、所有された `Uint8Array` copy を返す `onAccessUnit` を使用してください。
`onApplicationResourceView` も同じく callback 中だけ有効です。所有された copy が
必要な場合は `onApplicationResource` を使用します。

`TlvDemuxer` は `ApplicationResourceStore` も所有します。
`applicationResources()` で file の一覧を取得し、
`applicationResource(contextId, path)` で所有された file を取得できます。
`applications()` は現在の application state を返し、
`applicationEntry(contextId)` は ready 状態の entry document を解決します。
これにより、path validation、version replacement、entry resolution の規則を
各 browser loader で重複実装せず、C++／WASM 側に集約できます。

収録した stream を使う application-resource WASM integration test は、次のように
実行します。

```sh
node tests/wasm_application_resources.mjs build-wasm/tlvdemux.js test.tlv
```

`DurationProbe` は file や HTTP client を所有せずに、先頭／末尾への高速な range read
を制御します。既知の file size で開始し、`nextRange()` が返す各 object に対して
request を実行し、取得した byte 列をそのまま `pushRange()` へ渡します。
成功した `duration()` の `status` は `"complete"` です。失敗は `state()` と
`failure()` で明示され、file 全体の download へ暗黙に fallback することは
ありません。native の `tlvdemux probe INPUT` command も同じ protocol を使用します。

録画で正確に seek するには、stream 全体を入力する前に `startIndex(false)` を呼び、
実際の EOF で `finalizeIndex()` を呼びます。`seekPointsFor(targetUs)` は、対象時刻を
挟む RAP checkpoint を返します。`first.signallingOffset` へ移動してそこから入力し、
出力された RAP から decode を開始し、指定時刻以降で最初の frame を表示します。

recording index は demux session とは別の lifecycle を持ちます。VOD scan は
`building` から始まり、`finalizeIndex()` によって duration と seek point が complete に
なります。追いかけ録画では `startIndex(true)` を使い、source が永続的に成長を停止した
ときだけ finalize してください。`reposition()` は現在の index を維持しますが、
`reset()` または `selectService()` は有効な index を空から再開します。`flush()` だけでは
index は finalize されません。

### ブラウザーデモ

隣接する `libaribhtml5` receiver SDK と `build-wasm/tlvdemux.js` をビルドし、
repository root を配信して `/demo/` を開きます。

```sh
(cd ../libaribhtml5 && pnpm build:sdk)
node demo/server.mjs
```

同梱の development server は、duration probe と録画 seek に必要な `206` および
`Content-Range` response に対応しています。Python の簡易
`python3 -m http.server` は必要な Range 動作を提供しないため、この demo には
適しません。

demo はローカルの MMTS file または HTTP URL を受け取り、duration を probe してから、
選択された HEVC／AAC track を Media Source Extensions で再生します。WASM が収集した
新規の再生入口は常に timestamp 0 から開始します。preset の seek＋一時停止比較 button は
置かず、その後の位置変更はユーザーが明示的に seek した場合だけ行います。
application resource は、`libaribhtml5` に含まれる同一 origin の Service Worker VFS
を通じ、sandbox 化された data-broadcast iframe に公開されます。receiver API、
video-plane 処理、document preparation、内蔵 ROM sound、remote-control の動作も
`libaribhtml5` が提供し、外部 application URL は引き続き block されます。

ローカル file では `Blob.slice()` を使用します。remote file は正しい `206` と
`Content-Range` response を返す必要があります。Live mode は duration probe と seek
を行わず、通常の streaming `GET` を使い、Media Source を上限のない timeline として
公開します。有効な Range response を返さない HTTP URL は自動的に Live mode へ
fallback します。

demo は意図的に小さく保った fMP4／MSE layer を持ち、実行時には mmts.js に依存
しません。ただし、ブラウザー側の HEVC MSE 対応は必要です。

demux と fMP4 remux は public `worker/demux-worker-runtime.js` で実行されます。main thread は
transferable buffer として input chunk を送り、MSE init segment、media segment、
subtitle payload、application file、小さな control event だけを受け取ります。
`worker-tlvdemux.mjs` が RPC facade を担い、`worker/demux-worker-runtime.js` は consumer の
Worker loader でも bundle できる自己完結した classic Worker entry です。UI をこの public pair の外に
置くため、RPC と worker 側 demux lifecycle を複製せず presentation を変更できます。

再現可能な WASM throughput benchmark は次のように実行します。

```sh
npm run benchmark:wasm -- build-wasm/tlvdemux.js test.tlv 268435456
```

demux のみ、および demux と MSE を組み合わせた throughput、callback／segment 数、
output byte 数、観測された WASM heap size の最大値を表示します。hot path の
ownership map、測定方法、regression checklist は
[`docs/performance.md`](docs/performance.md) を参照してください。

## 現在の対応範囲

Version 0.1 は、検証用 stream で確認した ARIB broadcast subset に対応します。
具体的には、4 種類すべての HCfB compressed-IP mode（`0x20`、`0x21`、`0x60`、
`0x61`）、MMTP signalling と fragmented media、HEVC Annex B、AAC-LATM/LOAS、
ARIB STD-B62 TTML です。録画向け helper は、上限付きの duration probe、疎な RAP
index、録画先頭を基準とする再配置を提供します。CAS／descrambling、decoder と
TTML rendering、永続的な index serialization、汎用的な ISO MMT は現在の
ライブラリの対象外です。
