import { DataBroadcastController } from './data-broadcast.js?v=webkit-canvas-plane-v4';
import { HlgSdrRenderer } from '../hlg-sdr-renderer.mjs?v=cpp-color-lut-v1';
import {
  audioTrackChoices,
  correspondingAudioTrack,
  resolveLayerPair,
  sameVideoLayerGroup,
  selectionLevel,
  shouldRenderSubtitleTrack,
  subtitleTrackKind,
} from '../track-selection.mjs?v=public-selection-v1';
import { coalesceReadableStream } from '../stream-input.mjs?v=public-stream-v1';
import {
  commonBufferedRanges,
  createMsePlaybackFlowControl,
  startMsePlayback,
} from '../mse-playback.mjs?v=recorded-audio-window-v1';
import {
  createMseRecordedPlaybackController,
  createMseRecordedWindowLocator,
} from '../mse-recorded-playback.mjs?v=recorded-audio-window-v5';
import { createWorkerTlvDemuxModule } from '../worker-tlvdemux.mjs';
import {MseAppendQueue} from '../mse-append-queue.mjs?v=recorded-seek-entry-fence-v2';
import {createMseOutputPipeline} from '../mse-output-pipeline.mjs?v=audio-only-resilience-v1';
import {createMediaElementProxy, formatBytes}
  from './mse-media-transaction.js?v=recorded-seek-entry-fence-v2';
import {MSE_MAX_AUDIO_CHANNELS, createDemoTrackControls}
  from './track-controls.js?v=recorded-seek-fence-v1';
import {
  RangeUnsupportedError,
  createBlobRecordedSource,
  openHttpRecordedSource,
  probeRecordedDuration,
} from '../recorded-source.mjs?v=public-source-v1';

const b62RendererClass = import('/aribb62.js/dist/aribb62.js')
  .then(module => module.B62TTMLRenderer)
  .catch(error => {
    console.warn('ARIB-B62 字幕レンダラーを読み込めませんでした', error);
    return null;
  });

const MiB = 1024n * 1024n;
const LIVE_STARTUP_BUFFER_SECONDS = 0.5;
const LIVE_PUSH_TARGET_BYTES = 512 * 1024;
const LIVE_PUSH_MAX_DELAY_MS = 25;
const DEFAULT_PLAYBACK_RATE = 2;
const LIVE_PLAYBACK_RATE = 1;
const SHORT_RECORDING_THRESHOLD_SECONDS = 60;
const URL_STORAGE_KEY = 'tlvdemux.demo.httpUrl';
const AUDIO_STORAGE_KEY = 'tlvdemux.demo.audioPacketId';
const SUBTITLE_STORAGE_KEY = 'tlvdemux.demo.subtitlePacketId';
const EXPOSE_DEBUG_QUEUES = new URLSearchParams(location.search).has('tlvdemuxDebug');
const elements = Object.fromEntries([
  'wasmStatus', 'fileInput', 'urlInput', 'initialRange', 'maxRange',
  'videoPacketId', 'normalButton', 'cancelButton', 'clearButton',
  'probeState', 'duration', 'videoColor', 'sourceSize', 'transferred', 'log',
  'video', 'mediaInfo', 'liveMode', 'videoTrack', 'audioTrack', 'subtitleTrack', 'subtitleOverlay',
  'toneMappingMode', 'hlgSdrCanvas', 'hlgSdrWebGpuCanvas',
  'playbackNotice', 'videoRecoveryStatus',
  'captionVisible', 'superimposeVisible',
  'broadcastViewport', 'broadcastVideoSurface', 'broadcastMediaPlane', 'broadcastFrame', 'dataRemote',
  'dataStatus', 'dataDetail', 'dataUrl',
].map(id => [id, document.getElementById(id)]));

const dataBroadcast = new DataBroadcastController({
  viewport: elements.broadcastViewport,
  videoSurface: elements.broadcastVideoSurface,
  mediaPlane: elements.broadcastMediaPlane,
  video: elements.video,
  iframe: elements.broadcastFrame,
  remote: elements.dataRemote,
  status: elements.dataStatus,
  detail: elements.dataDetail,
  url: elements.dataUrl,
});
dataBroadcast.setLogger(appendLog);
const hlgSdrRenderer = new HlgSdrRenderer({
  video: elements.video,
  webGpuCanvas: elements.hlgSdrWebGpuCanvas,
  webGlCanvas: elements.hlgSdrCanvas,
  onError: (backend, error) =>
    appendLog(`${backend} HLG-SDR 補正を利用できません: ${error.message || error}`),
  onBackendChange: backend => appendLog(`HLG-SDR 補正レンダラー: ${backend}`),
});

function setHlgSdrEnabled(enabled) {
  hlgSdrRenderer.setEnabled(enabled);
}

function setHlgSdrLut(lut) {
  hlgSdrRenderer.setColorLut(lut);
}

let wasmModule = null;
let activeProbe = null;
let activeDemuxer = null;
let activeController = null;
let activeMediaSource = null;
let activeObjectUrl = null;
let activeQueues = [];
let activeQueueByType = new Map();
let runGeneration = 0;
let cachedProbe = null;
let activeDemuxIdentity = null;
let internalSeekTarget = null;
let currentLiveMode = false;
let activeVideoSwitch = null;
let activeVideoSelectionMode = null;
let activeAudioSwitch = null;
let activeSubtitleSwitch = null;
let activeSubtitleRenderer = null;
let activeRecordedPlaybackController = null;
let subtitleRendererRequest = 0;
let selectedAudioPacketId = null;
let selectedAudioGroupId = null;
let preferredAudioPacketId = null;
let selectedVideoPacketId = null;
let videoSelectionMode = 'auto';
let knownVideoTracks = new Map();
let currentVideoPresentationHint = null;
let currentVideoProperties = null;
let currentToneMappingMode = 'prototype';
let currentHlgSdrLut = null;
let prototypeHlgSdrLut = null;
let knownAudioTracks = new Map();
let selectedSubtitlePacketId = null;
let preferredSubtitlePacketId = null;
let knownSubtitleTracks = new Map();
let knownTtmlTracks = new Map();
let playbackQualityTimer = null;
let playbackMediaEventAbort = null;

elements.video.defaultPlaybackRate = DEFAULT_PLAYBACK_RATE;
elements.video.playbackRate = DEFAULT_PLAYBACK_RATE;

try {
  const savedUrl = localStorage.getItem(URL_STORAGE_KEY);
  if (savedUrl !== null) elements.urlInput.value = savedUrl;
  const savedAudio = localStorage.getItem(AUDIO_STORAGE_KEY);
  if (savedAudio !== null && /^\d+$/.test(savedAudio)) preferredAudioPacketId = Number(savedAudio);
  const savedSubtitle = localStorage.getItem(SUBTITLE_STORAGE_KEY);
  if (savedSubtitle !== null && /^\d+$/.test(savedSubtitle)) {
    preferredSubtitlePacketId = Number(savedSubtitle);
  }
} catch (_) {
  // localStorage may be unavailable for restricted or opaque origins.
}

elements.urlInput.addEventListener('input', () => {
  try { localStorage.setItem(URL_STORAGE_KEY, elements.urlInput.value); }
  catch (_) { /* Keep the demo usable when storage is unavailable. */ }
});

const BrowserMediaSource = globalThis.ManagedMediaSource || globalThis.MediaSource;

// Long-lived SDK objects use this proxy so an already-buffered candidate
// MediaElement can replace the visible element without retaining stale media
// clocks or frame-callback registrations.
const playbackMedia = createMediaElementProxy(() => elements.video);

const {
  mseAudioTrackSupported, videoTrackLabel, renderVideoTracks,
  preferredMseAudioTrack, audioChoiceValue, renderAudioTracks, renderSubtitleTracks,
} = createDemoTrackControls({
  elements, selectionLevel, audioTrackChoices,
  state: () => ({
    knownVideoTracks, videoSelectionMode, selectedVideoPacketId,
    knownAudioTracks, selectedAudioGroupId, preferredAudioPacketId, selectedAudioPacketId,
    knownSubtitleTracks, preferredSubtitlePacketId, selectedSubtitlePacketId,
  }),
});

function appendLog(message) {
  if (elements.log.textContent === '読み込み待ち…') elements.log.textContent = '';
  elements.log.textContent += `${message}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function effectiveToneMappingMode(mode = currentToneMappingMode) {
  if (mode !== 'auto') return mode;
  const hdrOutput = matchMedia('(video-dynamic-range: high)').matches ||
    matchMedia('(dynamic-range: high)').matches;
  return hdrOutput ? 'off' : 'force';
}

function isForcedToneMapping(mode) {
  return mode === 'force' || mode === 'on_compare';
}

function updateVideoColorStatus() {
  const effectiveMode = effectiveToneMappingMode();
  hlgSdrRenderer.setComparisonEnabled(
    effectiveMode === 'on_compare' || effectiveMode === 'prototype');
  if (!currentVideoProperties) {
    elements.videoColor.textContent = '—';
    delete elements.videoColor.dataset.state;
    setHlgSdrEnabled(false);
    return;
  }
  const sourceTransfer = currentVideoProperties.sourceColor?.transfer;
  const outputTransfer = currentVideoProperties.outputColor?.transfer;
  let label = '色彩情報なし';
  let state = 'unknown';
  if (currentVideoProperties.hlgSdrPrototype) {
    label = 'HLG-SDR 原型（左: carrier / 右: BT.2446）';
    state = 'hlg-sdr';
  } else if (currentVideoProperties.sdrInHlg ||
             (sourceTransfer === 18 && outputTransfer === 1)) {
    label = 'HLG-SDR';
    state = 'hlg-sdr';
  } else if (sourceTransfer === 16) {
    label = 'HDR · PQ';
    state = 'hdr';
  } else if (sourceTransfer === 18) {
    if (effectiveMode === 'prototype') {
      label = 'HLG-SDR 原型（適用待ち）';
      state = 'hlg-sdr';
    } else if (isForcedToneMapping(effectiveMode)) {
      label = 'HLG-SDR（適用待ち）';
      state = 'hlg-sdr';
    } else {
      label = currentVideoPresentationHint === 'hdr' ? 'HDR · HLG' : 'HLG（判定不能）';
      state = currentVideoPresentationHint === 'hdr' ? 'hdr' : 'hlg-unknown';
    }
  } else if (sourceTransfer === 1 || sourceTransfer === 11 || sourceTransfer === 14) {
    label = 'SDR';
    state = 'sdr';
  }
  elements.videoColor.textContent = label;
  elements.videoColor.dataset.state = state;
  const sourceIsHlg = sourceTransfer === 18;
  const applyLut = sourceIsHlg && effectiveMode !== 'off' &&
    (currentVideoProperties.hlgSdrPrototype ||
     isForcedToneMapping(effectiveMode) || currentVideoProperties.sdrInHlg);
  setHlgSdrEnabled(applyLut);
}

function toneMappingModeLabel(mode) {
  if (mode === 'force') return '強制 SDR 解釈';
  if (mode === 'on_compare') return '強制比較（左: 未補正 / 右: 補正）';
  if (mode === 'prototype') return '受控原型（左: carrier / 右: BT.2446）';
  return mode === 'off' ? '無効（原信号）' : '自動';
}

async function applyToneMappingMode(mode, announce = true) {
  if (!['auto', 'force', 'on_compare', 'prototype', 'off'].includes(mode)) return;
  currentToneMappingMode = mode;
  const lut = mode === 'prototype' ? prototypeHlgSdrLut : currentHlgSdrLut;
  if (lut) setHlgSdrLut(lut);
  if (activeDemuxer) await activeDemuxer.setMseToneMappingMode(effectiveToneMappingMode(mode));
  updateVideoColorStatus();
  if (announce) {
    appendLog(`HLG-SDR 補正を ${toneMappingModeLabel(mode)} に変更しました` +
      (activeDemuxer ? '（次の映像 RAP から適用）' : '（次回再生から適用）'));
  }
}

function mediaErrorMessage(error = elements.video.error) {
  if (!error) return null;
  const names = { 1: '中断', 2: 'ネットワーク', 3: 'デコード', 4: '非対応ソース' };
  return `MediaError ${names[error.code] || error.code}${error.message ? `: ${error.message}` : ''}`;
}

function durationSeconds(duration) { return Number(duration.value) / duration.timescale; }

function timestampMicroseconds(timestamp) {
  return BigInt(timestamp.value) * 1000000n / BigInt(timestamp.timescale);
}

function formatDuration(duration) {
  const seconds = durationSeconds(duration);
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${clock} (${seconds.toFixed(6)}s)`;
}

function parsePacketId() {
  const text = elements.videoPacketId.value.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error('映像 packet_id は 0..0xffff で指定してください');
  }
  return value;
}

function localSource(file) {
  return createBlobRecordedSource(file);
}

async function remoteSource(rawUrl, signal) {
  const url = new URL(rawUrl, window.location.href).href;
  return openHttpRecordedSource({url, signal});
}

function liveRemoteSource(rawUrl, signal) {
  const url = new URL(rawUrl, window.location.href).href;
  return {
    identity: `live:${url}`,
    label: url,
    size: null,
    async *stream() {
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) {
        throw new Error(`Live HTTP リクエストに失敗しました: ${response.status}`);
      }
      const reader = response.body.getReader();
      yield* coalesceReadableStream(reader, {
        targetBytes: LIVE_PUSH_TARGET_BYTES,
        maxDelayMilliseconds: LIVE_PUSH_MAX_DELAY_MS,
      });
    },
  };
}

async function selectedSource(signal, liveMode) {
  const file = elements.fileInput.files[0];
  if (file) return localSource(file);
  const url = elements.urlInput.value.trim();
  if (url) return liveMode ? liveRemoteSource(url, signal) : remoteSource(url, signal);
  throw new Error('ローカル MMTS ファイルまたは HTTP URL を指定してください');
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error(`${event} に失敗しました`)); };
    const cleanup = () => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

function setRunning(running) {
  elements.normalButton.disabled = running || !wasmModule;
  elements.cancelButton.disabled = !running;
  elements.fileInput.disabled = running;
  elements.urlInput.disabled = running;
  elements.liveMode.disabled = running;
}

function createSubtitleRenderer(liveMode) {
  const request = ++subtitleRendererRequest;
  activeSubtitleRenderer?.destroy();
  activeSubtitleRenderer = null;
  void b62RendererClass.then(Renderer => {
    if (!Renderer || request !== subtitleRendererRequest) return;
    try {
      activeSubtitleRenderer = new Renderer({
        mediaElement: elements.video,
        overlayElement: elements.subtitleOverlay,
        isLive: liveMode,
        maxCues: liveMode ? 300 : 100000,
        normalFont: '"Rounded M+ 1m for ARIB", "Hiragino Maru Gothic Pro", "BIZ UDGothic", "Yu Gothic Medium", sans-serif',
        forceStrokeColor: '#000000',
        strokeWidthInPlane: 4,
        backgroundPadding: '0 0.08em',
        lineBackground: true,
        captionVisible: elements.captionVisible.checked,
        superimposeVisible: elements.superimposeVisible.checked,
      });
    } catch (error) {
      activeSubtitleRenderer = null;
      console.warn('ARIB-B62 字幕レンダラーを初期化できませんでした', error);
    }
  });
}

function timestampMilliseconds(value, timescale) {
  if (value === null || value === undefined || !Number.isFinite(timescale) || timescale <= 0) {
    return undefined;
  }
  return Number(value) * 1000 / timescale;
}

function releaseMedia() {
  subtitleRendererRequest += 1;
  if (playbackQualityTimer !== null) clearInterval(playbackQualityTimer);
  playbackQualityTimer = null;
  activeMediaSource = null;
  activeAudioSwitch = null;
  activeVideoSwitch = null;
  activeVideoSelectionMode = null;
  activeSubtitleSwitch = null;
  void activeRecordedPlaybackController?.stop();
  activeRecordedPlaybackController = null;
  activeSubtitleRenderer?.destroy();
  activeSubtitleRenderer = null;
  internalSeekTarget = null;
  for (const queue of activeQueues) queue.destroy();
  elements.video.pause();
  elements.video.removeAttribute('src');
  elements.video.replaceChildren();
  elements.video.load();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  activeQueues = [];
  activeQueueByType = new Map();
}

function stopPlayback(quiet = false, preserveMedia = false) {
  runGeneration += 1;
  activeController?.abort();
  void activeProbe?.cancel();
  activeDemuxer?.delete();
  activeController = null;
  activeProbe = null;
  activeDemuxer = null;
  activeDemuxIdentity = null;
  activeAudioSwitch = null;
  activeVideoSwitch = null;
  activeVideoSelectionMode = null;
  activeSubtitleSwitch = null;
  void activeRecordedPlaybackController?.stop();
  activeRecordedPlaybackController = null;
  activeSubtitleRenderer?.reset();
  currentVideoPresentationHint = null;
  currentVideoProperties = null;
  updateVideoColorStatus();
  if (!preserveMedia) releaseMedia();
  setRunning(false);
  if (!quiet) {
    elements.probeState.textContent = '停止しました';
    elements.mediaInfo.textContent = '停止しました';
    appendLog('停止しました');
  }
}

async function probeDuration(source, generation) {
  const initialRangeSize = BigInt(elements.initialRange.value) * MiB;
  const maxRangeSize = BigInt(elements.maxRange.value) * MiB;
  if (maxRangeSize < initialRangeSize) throw new Error('最大 Range は初期 Range 以上にしてください');
  const options = { initialRangeSize, maxRangeSize };
  const videoPacketId = parsePacketId();
  if (videoPacketId !== undefined) options.videoPacketId = videoPacketId;
  const probe = new wasmModule.DurationProbe();
  activeProbe = probe;
  try {
    const probed = await probeRecordedDuration({
      source,
      probe,
      options,
      isActive: () => generation === runGeneration,
      onRange: request => {
        const end = request.offset + request.length - 1n;
        elements.probeState.textContent = `Range 検出 ${request.number}`;
        appendLog(`検出 #${request.number} bytes=${request.offset}-${end} ` +
          `(${formatBytes(request.length)})`);
      },
      onProgress: progress => {
        if (progress.transferredBytes !== null) {
          elements.transferred.textContent = formatBytes(progress.transferredBytes);
        }
      },
    });
    if (generation !== runGeneration) return null;
    return {
      duration: probed.duration,
      presentationStart: probed.presentationStart,
      presentationEnd: probed.presentationEnd,
      videoPacketId: probed.selectedVideoPacketId,
      presentationEndVideoPacketId: probed.presentationEndVideoPacketId,
      transferred: probed.transferredBytes,
    };
  } finally {
    if (activeProbe === probe) activeProbe = null;
  }
}

function bufferedAhead() {
  const ranges = elements.video.buffered;
  if (!ranges.length) return 0;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= elements.video.currentTime + 0.1 &&
        ranges.end(index) >= elements.video.currentTime) {
      return ranges.end(index) - elements.video.currentTime;
    }
  }
  return 0;
}

function monitorPlaybackQuality(generation) {
  if (playbackQualityTimer !== null) clearInterval(playbackQualityTimer);
  if (typeof elements.video.getVideoPlaybackQuality !== 'function') return;
  let previous = elements.video.getVideoPlaybackQuality();
  playbackQualityTimer = setInterval(() => {
    if (generation !== runGeneration) {
      clearInterval(playbackQualityTimer);
      playbackQualityTimer = null;
      return;
    }
    const current = elements.video.getVideoPlaybackQuality();
    const dropped = current.droppedVideoFrames - previous.droppedVideoFrames;
    const total = current.totalVideoFrames - previous.totalVideoFrames;
    activeRecordedPlaybackController?.reportPlaybackQuality({
      droppedFrames: dropped, totalFrames: total, durationSeconds: 5,
    });
    if (dropped > 0) {
      const ahead = bufferedAhead();
      const cause = ahead < 0.5 ? 'MSE 供給不足' : 'デコード/描画負荷';
      appendLog(`映像品質 ${cause}: 5秒で ${dropped}/${total} フレーム落ち、バッファ=${ahead.toFixed(1)}s`);
    }
    previous = current;
  }, 5000);
}

function isTimeBuffered(time) {
  const ranges = elements.video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= time && ranges.end(index) >= time + 0.1) return true;
  }
  return false;
}

async function playSource(source, probeResult, generation, startTimeSeconds = 0,
                          liveMode = false) {
  const mediaDuration = liveMode ? Infinity : durationSeconds(probeResult.duration);
  const playbackRate = liveMode || mediaDuration < SHORT_RECORDING_THRESHOLD_SECONDS
    ? LIVE_PLAYBACK_RATE : DEFAULT_PLAYBACK_RATE;
  elements.video.defaultPlaybackRate = playbackRate;
  elements.video.playbackRate = playbackRate;

  if (!BrowserMediaSource) {
    throw new Error('このブラウザーは Media Source Extensions に対応していません');
  }
  const mediaSource = new BrowserMediaSource();
  const opened = mediaSource.readyState === 'open'
    ? Promise.resolve() : once(mediaSource, 'sourceopen');
  activeMediaSource = mediaSource;
  activeObjectUrl = URL.createObjectURL(mediaSource);
  elements.video.replaceChildren();
  elements.video.src = activeObjectUrl;
  elements.video.load();
  await opened;
  if (generation !== runGeneration) return;
  mediaSource.duration = mediaDuration;

  const queues = new Map();
  activeQueueByType = queues;
  activeQueues = [];
  mediaSource.tlvdemuxQueues = queues;
  const tracks = new Map();
  let selectedVideo = null;
  let selectedAudio = null;
  let selectedSubtitle = null;
  let selectedVideoTrack = null;
  let layerPair = null;
  let locator = null;
  let recorded = null;
  let callbackError = null;
  let played = false;
  let demuxer = null;

  const commonAhead = () => {
    const range = commonBufferedRanges(queues).find(item =>
      item.start <= elements.video.currentTime + 0.05 &&
      item.end > elements.video.currentTime + 0.001);
    return range ? range.end - elements.video.currentTime : 0;
  };
  const maybeStartLivePlayback = () => {
    if (played || generation !== runGeneration ||
        !liveMode || !queues.has('video') || !queues.has('audio')) return;
    const started = startMsePlayback({
      media: elements.video, queues, liveMode: true,
      minimumLiveBufferSeconds: LIVE_STARTUP_BUFFER_SECONDS,
    });
    if (!started) return;
    played = true;
    monitorPlaybackQuality(generation);
    elements.probeState.textContent = 'Live 再生中';
    started.playResult.catch(() => {
      appendLog('自動再生がブロックされました。再生ボタンを押してください');
    });
  };
  const onUpdateEnd = () => {
    recorded?.notifyConsumption();
    maybeStartLivePlayback();
  };
  const pipeline = createMseOutputPipeline({
    mediaSource,
    media: elements.video,
    queues,
    requiredTracks: ['video', 'audio'],
    onUpdateEnd,
    queueOptions: {
      backBufferSeconds: 3,
      getMediaError: mediaElement => mediaErrorMessage(mediaElement.error),
    },
    queueFactory: (type, init, update, options) =>
      new MseAppendQueue(mediaSource, elements.video, init.mime, update, options),
    onQueueCreated(type, queue) {
      activeQueueByType.set(type, queue);
      if (!activeQueues.includes(queue)) activeQueues.push(queue);
    },
    onInitObserved: init => appendLog(`${init.type} 初期化 ${init.mime}`),
    onInitInstalled(init) {
      const details = init.type === 'video'
        ? `${init.width}x${init.height}`
        : `${init.sampleRate}Hz ${init.channels}ch`;
      elements.mediaInfo.textContent += ` · ${init.type} ${details}`;
    },
    onFirstSegment: type => appendLog(`${type} media segment 開始`),
  });

  const refreshLayerPair = () => {
    if (!selectedVideoTrack || selectedAudio === null) return;
    const audio = tracks.get(selectedAudio);
    layerPair = audio ? resolveLayerPair(
      [...tracks.values()], selectedVideoTrack, audio, selectedAudioGroupId,
    ) : null;
  };
  const selectAudio = track => {
    if (!mseAudioTrackSupported(track)) return false;
    selectedAudio = track.trackId;
    selectedAudioPacketId = track.packetId;
    selectedAudioGroupId = track.assetGroups?.[0]?.groupIdentification ?? null;
    void demuxer.selectTrack('audio', selectedAudio);
    refreshLayerPair();
    renderAudioTracks();
    return true;
  };
  const selectVideo = track => {
    selectedVideo = track.trackId;
    selectedVideoTrack = track;
    selectedVideoPacketId = track.packetId;
    void demuxer.selectTrack('video', selectedVideo);
    refreshLayerPair();
    renderVideoTracks();
  };
  const switchVideoMode = async (mode, reason) => {
    if (!layerPair || mode === 'frozen') return;
    const target = mode === 'rainfall' ? layerPair.fallback : layerPair.preferred;
    if (!target || target.video.trackId === selectedVideo) return;
    const accepted = await demuxer.switchLayer(
      target.video.trackId, target.audio.trackId,
      BigInt(Math.round(elements.video.currentTime * 1000000)) +
        (liveMode ? 0n : timestampMicroseconds(probeResult.presentationStart)),
    );
    if (!accepted) return;
    selectedVideo = target.video.trackId;
    selectedVideoTrack = target.video;
    selectedAudio = target.audio.trackId;
    appendLog(`${reason === 'decoder-performance' ? '復号負荷' : 'source damage'} により ` +
      `${mode === 'rainfall' ? '降雨対応' : '通常'}映像へ切替`);
  };

  const callbacks = {
    mseMaxAudioChannels: MSE_MAX_AUDIO_CHANNELS,
    onMseInit(init) { try { pipeline.onMseInit(init); } catch (error) { callbackError = error; } },
    onMseSegment(segment) {
      try { pipeline.onMseSegment(segment); } catch (error) { callbackError = error; }
    },
    onMseAudioSplice(splice) {
      try { pipeline.onMseAudioSplice(splice); } catch (error) { callbackError = error; }
    },
    onMseVideoSplice(splice) {
      try { pipeline.onMseVideoSplice(splice); } catch (error) { callbackError = error; }
    },
    onMseVideoRecovery(event) {
      if (event.phase === 'stable-rap-committed') recorded?.notifyPreferredStableRap();
    },
    onPlaybackDamage() {
      if (liveMode) return;
      recorded?.reportSourceDamage();
    },
    onTrack(track) {
      tracks.set(track.trackId, track);
      if (track.kind === 'video') {
        knownVideoTracks.set(track.packetId, track);
        if (selectedVideo === null &&
            (parsePacketId() === undefined || track.packetId === parsePacketId())) {
          selectVideo(track);
        }
      } else if (track.kind === 'audio') {
        knownAudioTracks.set(track.packetId, track);
        if (selectedAudio === null &&
            (preferredAudioPacketId === null || track.packetId === preferredAudioPacketId)) {
          selectAudio(track);
        }
      } else if (track.kind === 'subtitle' && track.codec === 'ttml') {
        knownSubtitleTracks.set(track.packetId, track);
        if (selectedSubtitle === null) {
          selectedSubtitle = track.trackId;
          selectedSubtitlePacketId = track.packetId;
          void demuxer.selectTrack('subtitle', selectedSubtitle);
        }
      }
      refreshLayerPair();
      renderVideoTracks();
      renderAudioTracks();
      renderSubtitleTracks();
    },
    onTrackRemoved(track) {
      tracks.delete(track.trackId);
      // Recorded byte reposition rebuilds the transient catalogue.  Keep the
      // transaction-owned track identities stable until the same tracks are
      // announced again; clearing them here lets callback order silently pick
      // another AAC track midway through an audio-first locate/landing.
      if (liveMode) {
        if (track.trackId === selectedVideo) selectedVideo = null;
        if (track.trackId === selectedAudio) selectedAudio = null;
        if (track.trackId === selectedSubtitle) selectedSubtitle = null;
      }
      knownVideoTracks.delete(track.packetId);
      knownAudioTracks.delete(track.packetId);
      knownSubtitleTracks.delete(track.packetId);
      refreshLayerPair();
    },
    onPlaybackAccessUnitView(unit) {
      locator?.observeAccessUnit(unit);
      if (unit.codec === 'ttml' && unit.trackId === selectedSubtitle) {
        dataBroadcast.captionDataChanged(unit);
      }
    },
    onBroadcastClock: clock => dataBroadcast.broadcastClockChanged(clock),
    onEventInfo: event => dataBroadcast.eventInformationChanged(event),
    onApplicationResourceView: resource => dataBroadcast.resourceChanged(resource),
    onApplicationState: state => dataBroadcast.applicationStateChanged(demuxer, state),
    onApplicationResourcesReset: () => dataBroadcast.resourcesReset(),
    onError(error) {
      if (!error.recoverable) callbackError = new Error(error.message);
      else appendLog(`分離警告 @${error.inputOffset}: ${error.message}`);
    },
  };

  demuxer = new wasmModule.TlvDemuxer(callbacks);
  activeDemuxer = demuxer;
  activeDemuxIdentity = Object.freeze({generation, demuxer, sourceIdentity: source.identity});
  await demuxer.configureTrackSelection({
    videoPacketId: parsePacketId(),
    audioPacketId: preferredAudioPacketId,
    subtitlePacketId: preferredSubtitlePacketId,
  });
  await demuxer.setMseToneMappingMode(effectiveToneMappingMode());
  await demuxer.setSubtitlePassthroughEnabled(true);
  if (!liveMode) {
    await demuxer.setMseTimestampOffset(-timestampMicroseconds(probeResult.presentationStart));
    await demuxer.startIndex(false);
    await demuxer.setIndexDuration(timestampMicroseconds(probeResult.presentationEnd));
  }
  await demuxer.setMseOutputEnabled(true);

  activeAudioSwitch = async packetId => {
    const track = knownAudioTracks.get(packetId);
    if (!track || !selectAudio(track)) throw new Error('選択した音声は利用できません');
  };
  activeVideoSwitch = async packetId => {
    const track = knownVideoTracks.get(packetId);
    if (!track) throw new Error('選択した映像は利用できません');
    selectVideo(track);
  };
  activeVideoSelectionMode = value => {
    if (value === null) {
      videoSelectionMode = 'auto';
      return Promise.resolve();
    }
    videoSelectionMode = 'fixed';
    return activeVideoSwitch(value);
  };

  if (liveMode) {
    const flow = createMsePlaybackFlowControl({
      media: playbackMedia, queues, entryKind: 'live',
      highSeconds: 2, lowSeconds: 1, backBufferSeconds: 3,
    });
    for await (const data of source.stream()) {
      if (generation !== runGeneration) return;
      if (!await demuxer.push(data)) throw new Error('Live 分離入力に失敗しました');
      if (callbackError) throw callbackError;
      await flow.afterPush(data.byteLength, () => generation === runGeneration);
    }
  } else {
    locator = createMseRecordedWindowLocator({
      source, demuxer, queues,
      presentationStartUs: timestampMicroseconds(probeResult.presentationStart),
      presentationEndUs: timestampMicroseconds(probeResult.presentationEnd),
      selectedAudioTrack: () => selectedAudio,
      preferredVideoTrack: () => layerPair?.preferred.video ?? selectedVideo,
      rainfallVideoTrack: () => layerPair?.fallback?.video ?? null,
      activateVideoTrack: async mode => {
        if (mode === 'rainfall') await switchVideoMode('rainfall', 'source-damage');
      },
      onProgress: progress => {
        elements.transferred.textContent =
          `${formatBytes(probeResult.transferred + progress.bytesRead)} / seek 16 MiB`;
      },
    });
    recorded = createMseRecordedPlaybackController({
      source, demuxer, media: elements.video, queues,
      commonAhead,
      locateSeekWindow: locator.locate,
      switchVideoMode,
      play: () => {
        const started = startMsePlayback({
          media: elements.video, queues, liveMode: false,
        });
        if (!started) throw new Error('Recorded の共通 A/V entry が再生時刻を覆っていません');
        return started.playResult;
      },
      onPlaybackStart: ({quotaLimited, playResult}) => {
        played = true;
        monitorPlaybackQuality(generation);
        elements.probeState.textContent = '再生中';
        if (quotaLimited) appendLog('MSE quota 上限で共通 A/V entry から再生を開始');
        Promise.resolve(playResult).catch(() => {
          appendLog('自動再生がブロックされました。再生ボタンを押してください');
        });
      },
      onProgress: state => {
        elements.transferred.textContent =
          `${formatBytes(BigInt(state.nextOffset))} / ${formatBytes(source.size)} · ` +
          `共通バッファ=${Number(state.commonAhead).toFixed(1)}s`;
      },
      onStateChange: state => {
        if (state.state === 'error') {
          elements.playbackNotice.textContent =
            '録画の音声窓と映像を同時に準備できませんでした。別の位置を選ぶか再試行してください。';
          elements.playbackNotice.hidden = false;
        }
      },
    });
    activeRecordedPlaybackController = recorded;
    await recorded.start(startTimeSeconds);
    if (generation !== runGeneration) return;
  }

  await demuxer.flush();
  if (callbackError) throw callbackError;
  if (!liveMode) await demuxer.finalizeIndex();
  maybeStartLivePlayback();
  await pipeline.finalize();
  elements.probeState.textContent = liveMode ? 'Live 終了' : '読み込み完了';
  appendLog(liveMode ? 'Live ストリームが終了しました' : 'ストリーム終端です');
}
async function loadAndPlay(startTimeSeconds = 0, reuseMedia = false,
                           initialLoad = false) {
  if (initialLoad) dataBroadcast.beginSession();
  if (!reuseMedia) {
    releaseMedia();
    knownAudioTracks = new Map();
    knownVideoTracks = new Map();
    currentVideoPresentationHint = null;
    currentVideoProperties = null;
    updateVideoColorStatus();
    selectedVideoPacketId = null;
    videoSelectionMode = elements.videoPacketId.value.trim() === '' ? 'auto' : 'fixed';
    selectedAudioPacketId = null;
    selectedAudioGroupId = null;
    renderAudioTracks();
    knownSubtitleTracks = new Map();
    knownTtmlTracks = new Map();
    selectedSubtitlePacketId = null;
    renderSubtitleTracks();
  }
  const generation = ++runGeneration;
  const controller = new AbortController();
  activeController = controller;
  setRunning(true);
  if (initialLoad) elements.duration.textContent = '—';
  elements.sourceSize.textContent = '—';
  if (initialLoad) {
    currentVideoProperties = null;
    updateVideoColorStatus();
  }
  elements.transferred.textContent = '—';
  elements.probeState.textContent = '入力情報を確認中';
  elements.mediaInfo.textContent = '準備中';
  elements.playbackNotice.hidden = true;
  elements.playbackNotice.textContent = '';
  elements.videoRecoveryStatus.textContent = '';
  if (initialLoad) elements.log.textContent = '';
  try {
    let liveMode = elements.liveMode.checked;
    currentLiveMode = liveMode;
    if (liveMode && startTimeSeconds > 0) throw new Error('Live mode ではシークできません');
    let source;
    try {
      source = await selectedSource(controller.signal, liveMode);
    } catch (error) {
      if (!(error instanceof RangeUnsupportedError) || liveMode || elements.fileInput.files[0]) throw error;
      liveMode = true;
      currentLiveMode = true;
      elements.liveMode.checked = true;
      appendLog('Range 非対応のため Live mode に切り替えました');
      source = await selectedSource(controller.signal, true);
    }
    if (generation !== runGeneration) return;
    elements.sourceSize.textContent = liveMode && source.size === null
      ? 'Live' : formatBytes(source.size);
    appendLog(`入力 ${source.label}`);
    appendLog(liveMode ? 'モード Live ストリーム' : `サイズ ${source.size} (${formatBytes(source.size)})`);
    let probeResult;
    if (liveMode) {
      probeResult = { duration: null, transferred: 0n };
      elements.duration.textContent = 'Live';
    } else if (cachedProbe && cachedProbe.identity === source.identity && cachedProbe.size === source.size) {
      probeResult = cachedProbe.result;
      appendLog(`再生時間キャッシュ ${durationSeconds(probeResult.duration).toFixed(6)}s`);
    } else {
      probeResult = await probeDuration(source, generation);
      if (probeResult) cachedProbe = { identity: source.identity, size: source.size, result: probeResult };
    }
    if (!probeResult || generation !== runGeneration) return;
    if (!liveMode) {
      elements.duration.textContent = formatDuration(probeResult.duration);
      appendLog(`再生時間 ${durationSeconds(probeResult.duration).toFixed(6)}s、検出読み込み ${formatBytes(probeResult.transferred)}`);
    }
    await playSource(
      source, probeResult, generation, startTimeSeconds, liveMode,
    );
  } catch (error) {
    if (generation !== runGeneration || error.name === 'AbortError') return;
    elements.probeState.textContent = '失敗';
    elements.mediaInfo.textContent = error.message || String(error);
    appendLog(`エラー ${error.message || error}`);
    if (error?.diagnostics) {
      appendLog(`診断 ${JSON.stringify(error.diagnostics,
        (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
    }
    console.error(error);
  } finally {
    if (generation === runGeneration) {
      void activeProbe?.cancel();
      activeProbe = null;
      activeDemuxer?.delete();
      activeDemuxer = null;
      activeController = null;
      setRunning(false);
    }
  }
}

elements.normalButton.addEventListener('click', () => loadAndPlay(0, false, true));
elements.cancelButton.addEventListener('click', stopPlayback);
elements.clearButton.addEventListener('click', () => { elements.log.textContent = ''; });
elements.toneMappingMode.addEventListener('change', () => {
  applyToneMappingMode(elements.toneMappingMode.value).catch(error => {
    appendLog(`HLG-SDR 補正の変更に失敗しました: ${error.message || error}`);
    elements.toneMappingMode.value = currentToneMappingMode;
  });
});
elements.videoTrack.addEventListener('change', () => {
  const value = elements.videoTrack.value;
  if (!activeVideoSelectionMode) return;
  activeVideoSelectionMode(value === '' ? null : Number(value)).catch(error => {
    appendLog(`映像レイヤー切替エラー ${error.message || error}`);
    console.error(error);
    renderVideoTracks();
  });
});
elements.audioTrack.addEventListener('change', () => {
  const value = elements.audioTrack.value;
  const choice = audioTrackChoices(
    knownAudioTracks.values(), mseAudioTrackSupported,
  ).find(item => audioChoiceValue(item) === value);
  preferredAudioPacketId = choice?.track.packetId ?? null;
  try {
    if (preferredAudioPacketId === null) localStorage.removeItem(AUDIO_STORAGE_KEY);
    else localStorage.setItem(AUDIO_STORAGE_KEY, String(preferredAudioPacketId));
  } catch (_) { /* Keep track switching available without storage. */ }
  const target = choice?.track ?? preferredMseAudioTrack(knownAudioTracks, preferredAudioPacketId);
  if (target && activeAudioSwitch) {
    activeAudioSwitch(target.packetId, choice?.groupIdentification ?? null).catch(error => {
      appendLog(`音声切替エラー ${error.message || error}`);
      console.error(error);
      renderAudioTracks();
    });
  }
});
elements.subtitleTrack.addEventListener('change', () => {
  const value = elements.subtitleTrack.value;
  preferredSubtitlePacketId = value === '' ? null : Number(value);
  try {
    if (preferredSubtitlePacketId === null) localStorage.removeItem(SUBTITLE_STORAGE_KEY);
    else localStorage.setItem(SUBTITLE_STORAGE_KEY, String(preferredSubtitlePacketId));
  } catch (_) { /* Keep track switching available without storage. */ }
  const target = preferredSubtitlePacketId === null
    ? knownSubtitleTracks.values().next().value
    : knownSubtitleTracks.get(preferredSubtitlePacketId);
  if (target && activeSubtitleSwitch) {
    try { activeSubtitleSwitch(target.packetId); }
    catch (error) {
      appendLog(`字幕切替エラー ${error.message || error}`);
      console.error(error);
    }
  }
});
elements.captionVisible.addEventListener('change', () => {
  activeSubtitleRenderer?.setTrackVisibility('caption', elements.captionVisible.checked);
});
elements.superimposeVisible.addEventListener('change', () => {
  activeSubtitleRenderer?.setTrackVisibility('superimpose', elements.superimposeVisible.checked);
});
function bindPlaybackMediaEvents(media) {
  playbackMediaEventAbort?.abort();
  playbackMediaEventAbort = new AbortController();
  const options = {signal: playbackMediaEventAbort.signal};
  media.addEventListener('error', () => {
    const message = mediaErrorMessage();
    appendLog(`映像エラー ${message || '不明'}`);
    elements.probeState.textContent = 'デコード失敗';
    elements.mediaInfo.textContent = message || 'MediaElement エラー';
    if (activeRecordedPlaybackController) {
      activeRecordedPlaybackController.reportPlaybackQuality({
        totalFrames: 0, droppedFrames: 0, durationSeconds: 0,
        mediaError: media.error ?? message,
      });
    } else {
      activeController?.abort();
    }
  }, options);
  media.addEventListener('waiting', () => {
    appendLog(`MediaElement waiting ${media.currentTime.toFixed(3)}s`);
  }, options);
  media.addEventListener('pause', () => {
  }, options);
  media.addEventListener('play', () => {
  }, options);
  media.addEventListener('seeking', () => {
    if (currentLiveMode || !activeRecordedPlaybackController) return;
    const target = media.currentTime;
    if (internalSeekTarget !== null && Math.abs(target - internalSeekTarget) < 0.1) return;
    internalSeekTarget = target;
    appendLog(`ユーザーシーク ${target.toFixed(3)}s（AAC window を先に確定）`);
    void activeRecordedPlaybackController.seek(target).catch(error => {
      appendLog(`シークエラー ${error.message || error}`);
      internalSeekTarget = null;
    });
  }, options);
  media.addEventListener('seeked', () => {
    if (internalSeekTarget !== null &&
        Math.abs(media.currentTime - internalSeekTarget) < 0.1) {
      internalSeekTarget = null;
    }
  }, options);
  media.addEventListener('timeupdate', () => {
    activeRecordedPlaybackController?.notifyConsumption();
  }, options);
  media.addEventListener('ratechange', () => {
    activeRecordedPlaybackController?.setPlaybackRate(media.playbackRate);
  }, options);
  if (typeof media.requestVideoFrameCallback === 'function') {
    let frameHandle = null;
    const observe = (_now, metadata) => {
      activeRecordedPlaybackController?.notifyPresentedFrame(metadata.mediaTime);
      frameHandle = media.requestVideoFrameCallback(observe);
    };
    frameHandle = media.requestVideoFrameCallback(observe);
    options.signal.addEventListener('abort', () => {
      if (frameHandle !== null) media.cancelVideoFrameCallback?.(frameHandle);
    }, {once: true});
  }
}

bindPlaybackMediaEvents(elements.video);

createWorkerTlvDemuxModule({
  wasmUrl: new URL('../dist/tlvdemux.js?v=recorded-audio-window-v5', import.meta.url).href,
}).then(module => {
  wasmModule = module;
  elements.wasmStatus.textContent = 'WASM Worker 準備完了';
  elements.wasmStatus.className = 'badge';
  setRunning(false);
  loadAndPlay(0, false, true);
}).catch(error => {
  elements.wasmStatus.textContent = 'WASM Worker 読み込み失敗';
  elements.wasmStatus.className = 'badge error';
  elements.probeState.textContent = '読み込み失敗';
  appendLog(`WASM Worker エラー ${error.message || error}`);
});
