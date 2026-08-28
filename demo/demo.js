import { DataBroadcastController } from './data-broadcast.js?v=webkit-canvas-plane-v4';
import { HlgSdrRenderer } from '../hlg-sdr-renderer.mjs?v=cpp-color-lut-v1';
import {
  automaticLayerSwitchEnabled,
  audioTrackChoices,
  configureAutomaticLayerPair as configureSdkAutomaticLayerPair,
  correspondingAudioTrack,
  resolveLayerPair,
  sameVideoLayerGroup,
  selectionLevel,
  shouldReprobeVideoLayerForSeek,
  shouldRenderSubtitleTrack,
  subtitleTrackKind,
} from '../track-selection.mjs?v=public-selection-v1';
import { coalesceReadableStream } from '../stream-input.mjs?v=public-stream-v1';
import {
  commonBufferedRanges,
  startMsePlayback,
} from '../mse-playback.mjs?v=audio-only-resilience-v1';
import {
  createMsePlaybackFlowControl,
  createMseRecordedSeekSession,
} from '../mse-playback.mjs?v=damage-resume-v4';
import { createWorkerTlvDemuxModule } from '../worker-tlvdemux.mjs';
import {
  MseAppendQueue,
} from '../mse-append-queue.mjs?v=gap-recovery-v1';
import {createMseOutputPipeline} from '../mse-output-pipeline.mjs?v=audio-only-resilience-v1';
import {
  MsePlaybackMode,
  createDemoPlaybackResilience,
} from './playback-resilience.js?v=audio-only-resilience-v1';
import {createLiveMseTransitionManager}
  from '../mse-live-transition.mjs?v=audio-only-resilience-v1';
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
const PLAYBACK_CHUNK = 2n * MiB;
const FORWARD_BUFFER_HIGH_SECONDS = 15;
const FORWARD_BUFFER_LOW_SECONDS = 8;
const LIVE_STARTUP_BUFFER_SECONDS = 0.5;
const BACK_BUFFER_SECONDS = 8;
const SOURCE_QUEUE_HIGH_BYTES = 4 * 1024 * 1024;
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
let seekTimer = null;
let internalSeekTarget = null;
let currentLiveMode = false;
let activeVideoSwitch = null;
let activeVideoSelectionMode = null;
let activeAudioSwitch = null;
let activeSubtitleSwitch = null;
let activeSubtitleRenderer = null;
let activeGapRecovery = null;
let activeLiveTransitionManager = null;
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

const AUDIO_LAYOUTS = [
  '不明', 'モノラル', 'デュアルモノ', 'ステレオ', '2.1ch', '3.0ch', '2.2ch',
  '4.0ch', '5.0ch', '5.1ch', '3.3.1ch', '6.1ch', '7.1ch', '10.2ch', '22.2ch',
];
const MSE_MAX_AUDIO_CHANNELS = 6;
const BrowserMediaSource = globalThis.ManagedMediaSource || globalThis.MediaSource;

// Long-lived SDK objects use this proxy so an already-buffered candidate
// MediaElement can replace the visible element without retaining stale media
// clocks or frame-callback registrations.
const playbackMedia = {
  get currentTime() { return elements.video.currentTime; },
  set currentTime(value) { elements.video.currentTime = value; },
  get paused() { return elements.video.paused; },
  get seeking() { return elements.video.seeking; },
  get ended() { return elements.video.ended; },
  get error() { return elements.video.error; },
  get buffered() { return elements.video.buffered; },
  get videoFrameCallbackSupported() {
    return typeof elements.video.requestVideoFrameCallback === 'function';
  },
  play() { return elements.video.play(); },
  pause() { return elements.video.pause(); },
  requestVideoFrameCallback(callback) {
    const media = elements.video;
    return {media, id: media.requestVideoFrameCallback(callback)};
  },
  cancelVideoFrameCallback(request) {
    request?.media?.cancelVideoFrameCallback?.(request.id);
  },
};

function mseAudioTrackSupported(track) {
  const channels = track.audio?.channels ?? 0;
  return channels === 0 || channels <= MSE_MAX_AUDIO_CHANNELS;
}

function videoTrackLabel(track) {
  const level = selectionLevel(track);
  const layer = level === 0 ? '通常' : level === 1 ? '降雨対応' : `level=${level ?? '—'}`;
  return `${layer} · 0x${track.packetId.toString(16)}`;
}

function renderVideoTracks() {
  elements.videoTrack.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = '自動';
  elements.videoTrack.append(automatic);
  const sorted = [...knownVideoTracks.values()].sort((left, right) =>
    (selectionLevel(left) ?? 0xff) - (selectionLevel(right) ?? 0xff) ||
    left.packetId - right.packetId);
  for (const track of sorted) {
    const option = document.createElement('option');
    option.value = String(track.packetId);
    option.textContent = videoTrackLabel(track);
    elements.videoTrack.append(option);
  }
  elements.videoTrack.value = videoSelectionMode === 'fixed' &&
    selectedVideoPacketId !== null &&
    knownVideoTracks.has(selectedVideoPacketId) ? String(selectedVideoPacketId) : '';
  elements.videoTrack.disabled = knownVideoTracks.size < 2;
}

function preferredMseAudioTrack(tracks, preferredPacketId = null) {
  const compatible = [...tracks.values()].filter(mseAudioTrackSupported);
  if (preferredPacketId !== null) {
    const preferred = compatible.find(track => track.packetId === preferredPacketId);
    if (preferred) return preferred;
  }
  return compatible.find(track => track.audio?.mainComponent) || compatible[0];
}

function audioTrackLabel(track) {
  const parts = [`0x${track.packetId.toString(16)}`];
  if (track.language) parts.push(track.language);
  if (track.audio) {
    parts.push(AUDIO_LAYOUTS[track.audio.channelLayout] || `${track.audio.channelLayout}ch`);
    if (track.audio.sampleRate) parts.push(`${track.audio.sampleRate}Hz`);
    if (track.audio.mainComponent) parts.push('メイン');
    if (track.audio.multilingual) parts.push('二か国語');
  }
  if (!mseAudioTrackSupported(track)) parts.push('MSE 非対応');
  return parts.join(' · ');
}

function audioChoiceValue(choice) {
  return choice.groupIdentification === null
    ? `track:${choice.track.packetId}`
    : `group:${choice.groupIdentification}`;
}

function renderAudioTracks() {
  elements.audioTrack.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = '自動';
  elements.audioTrack.append(automatic);
  const choices = audioTrackChoices(knownAudioTracks.values(), mseAudioTrackSupported);
  for (const choice of choices) {
    const {track, groupIdentification} = choice;
    const option = document.createElement('option');
    option.value = audioChoiceValue(choice);
    option.textContent = groupIdentification === null
      ? audioTrackLabel(track)
      : `${audioTrackLabel(track)} · group=0x${groupIdentification.toString(16)}`;
    option.disabled = !mseAudioTrackSupported(track);
    elements.audioTrack.append(option);
  }
  let desiredGroup = selectedAudioGroupId;
  if (desiredGroup === null && preferredAudioPacketId !== null) {
    desiredGroup = knownAudioTracks.get(preferredAudioPacketId)?.assetGroups?.[0]
      ?.groupIdentification ?? null;
  }
  const desiredChoice = desiredGroup !== null
    ? choices.find(choice => choice.groupIdentification === desiredGroup)
    : choices.find(choice => choice.track.packetId ===
        (selectedAudioPacketId ?? preferredAudioPacketId));
  elements.audioTrack.value = desiredChoice ? audioChoiceValue(desiredChoice) : '';
  elements.audioTrack.disabled = choices.length === 0;
}

function subtitleTrackLabel(track) {
  const parts = [`字幕 · 0x${track.packetId.toString(16)}`];
  if (track.language) parts.push(track.language);
  if (track.subtitle) {
    parts.push(`mode=${track.subtitle.operationMode}`);
    parts.push(`timing=${track.subtitle.timingMode}`);
    parts.push(`display=${track.subtitle.displayMode}`);
  }
  return parts.join(' · ');
}

function renderSubtitleTracks() {
  elements.subtitleTrack.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = '自動';
  elements.subtitleTrack.append(automatic);
  for (const track of [...knownSubtitleTracks.values()].sort((a, b) => a.packetId - b.packetId)) {
    const option = document.createElement('option');
    option.value = String(track.packetId);
    option.textContent = subtitleTrackLabel(track);
    elements.subtitleTrack.append(option);
  }
  const desired = preferredSubtitlePacketId ?? selectedSubtitlePacketId;
  elements.subtitleTrack.value = desired !== null && knownSubtitleTracks.has(desired)
    ? String(desired) : '';
  elements.subtitleTrack.disabled = knownSubtitleTracks.size === 0;
}

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

function formatBytes(value) {
  const byteCount = typeof value === 'bigint' ? value : BigInt(value);
  if (byteCount < 1024n) return `${byteCount} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = Number(byteCount);
  let unit = -1;
  do { scaled /= 1024; unit += 1; } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[unit]}`;
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
  activeGapRecovery?.destroy();
  activeGapRecovery = null;
  activeLiveTransitionManager?.destroy();
  activeLiveTransitionManager = null;
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
  activeAudioSwitch = null;
  activeVideoSwitch = null;
  activeVideoSelectionMode = null;
  activeSubtitleSwitch = null;
  activeGapRecovery?.destroy();
  activeGapRecovery = null;
  activeLiveTransitionManager?.destroy();
  activeLiveTransitionManager = null;
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
                          liveMode = false, reuseMedia = false,
                          initialPlaybackMode = MsePlaybackMode.AUDIO_VIDEO) {
  const recordingDurationSeconds = liveMode ? Infinity : durationSeconds(probeResult.duration);
  const playbackRate = liveMode || recordingDurationSeconds < SHORT_RECORDING_THRESHOLD_SECONDS
    ? LIVE_PLAYBACK_RATE
    : DEFAULT_PLAYBACK_RATE;
  elements.video.defaultPlaybackRate = playbackRate;
  elements.video.playbackRate = playbackRate;
  if (!liveMode && playbackRate === LIVE_PLAYBACK_RATE) {
    appendLog(`60 秒未満の録画は ${LIVE_PLAYBACK_RATE}× で再生します`);
  }
  let mediaSource;
  const openDetachedMediaSource = async (MediaSourceClass, mediaElement) => {
    const fresh = new MediaSourceClass();
    const opened = fresh.readyState === 'open'
      ? Promise.resolve()
      : once(fresh, 'sourceopen');
    const url = URL.createObjectURL(fresh);
    if (typeof globalThis.ManagedMediaSource === 'function' &&
        fresh instanceof globalThis.ManagedMediaSource) {
      mediaElement.disableRemotePlayback = true;
    }
    mediaElement.src = url;
    mediaElement.load();
    if (typeof globalThis.ManagedMediaSource === 'function' &&
        fresh instanceof globalThis.ManagedMediaSource) {
      await mediaElement.play().catch(() => {});
    }
    await opened;
    return {mediaSource: fresh, url};
  };
  const openFreshMediaSource = async () => {
    if (!BrowserMediaSource) {
      throw new Error('このブラウザーは Media Source Extensions に対応していません');
    }
    activeQueueByType = new Map();
    if (EXPOSE_DEBUG_QUEUES) globalThis.__tlvdemuxDebugQueues = activeQueueByType;
    const fresh = new BrowserMediaSource();
    // Register before attaching the object URL. WebKit may transition to open
    // while load()/play() is running, before code after those calls resumes.
    const opened = fresh.readyState === 'open'
      ? Promise.resolve()
      : once(fresh, 'sourceopen');
    fresh.tlvdemuxQueues = activeQueueByType;
    activeMediaSource = fresh;
    activeObjectUrl = URL.createObjectURL(fresh);
    elements.video.replaceChildren();
    if (typeof globalThis.ManagedMediaSource === 'function' &&
        fresh instanceof globalThis.ManagedMediaSource) {
      // WebKit only activates ManagedMediaSource when an AirPlay fallback is
      // present or remote playback is explicitly disabled. The raw TLV demo
      // has no native AirPlay source, so opt out before attaching the blob URL.
      elements.video.disableRemotePlayback = true;
      appendLog('ManagedMediaSource: Remote Playback を無効化しました');
    }
    elements.video.src = activeObjectUrl;
    elements.video.load();
    if (typeof globalThis.ManagedMediaSource === 'function' &&
        fresh instanceof globalThis.ManagedMediaSource) {
      // iOS starts a ManagedMediaSource only after the media element enters
      // playback. The element is muted/playsinline, so this is autoplay-safe.
      elements.video.play().catch(() => {});
    }
    await opened;
    appendLog(`${typeof globalThis.ManagedMediaSource === 'function' &&
      fresh instanceof globalThis.ManagedMediaSource
      ? 'ManagedMediaSource' : 'MediaSource'} を使用します`);
    return fresh;
  };
  if (reuseMedia && (!activeMediaSource || !activeObjectUrl)) reuseMedia = false;
  if (reuseMedia) {
    mediaSource = activeMediaSource;
    const registry = mediaSource.tlvdemuxQueues;
    if (mediaSource.readyState !== 'open' || !(registry instanceof Map) ||
        registry.size !== mediaSource.sourceBuffers.length) {
      appendLog(`MediaSource を再構築します (状態=${mediaSource.readyState})`);
      releaseMedia();
      reuseMedia = false;
    } else {
      activeQueueByType = registry;
      activeQueues = [...registry.values()];
      await Promise.all(activeQueues.map(queue => queue.quiesce()));
    }
  }
  if (!reuseMedia) {
    mediaSource = await openFreshMediaSource();
  }
  if (generation !== runGeneration) return;
  if (mediaSource.readyState !== 'open') {
    appendLog(`シーク準備中に MediaSource が ${mediaSource.readyState} になったため再構築します`);
    if (mediaSource === activeMediaSource) releaseMedia();
    reuseMedia = false;
    mediaSource = await openFreshMediaSource();
    if (generation !== runGeneration) return;
  }
  const mediaDuration = liveMode ? Infinity : durationSeconds(probeResult.duration);
  try {
    mediaSource.duration = mediaDuration;
  } catch (error) {
    if (error.name !== 'InvalidStateError') throw error;
    appendLog(`MediaSource 設定競合 (${error.message}) のため再構築します`);
    if (mediaSource === activeMediaSource) releaseMedia();
    reuseMedia = false;
    mediaSource = await openFreshMediaSource();
    if (generation !== runGeneration) return;
    mediaSource.duration = mediaDuration;
  }
  for (const queue of activeQueues) queue.resume();
  createSubtitleRenderer(liveMode);

  let queues = reuseMedia ? new Map(activeQueueByType) : new Map();
  const requiredTracks = initialPlaybackMode === MsePlaybackMode.AUDIO_ONLY
    ? ['audio'] : ['video', 'audio'];
  const tracks = new Map();
  let selectedVideo = null;
  let selectedVideoTrack = null;
  let pendingLayerSwitch = null;
  let switchInFlight = false;
  let automaticLayerPairSignature = null;
  let automaticLayerPairUpdate = Promise.resolve();
  let selectedAudio = null;
  let selectedSubtitle = null;
  let subtitleEventCount = 0;
  let videoDiscontinuityCount = 0;
  let audioDiscontinuityCount = 0;
  let callbackError = null;
  let recoverableErrors = 0;
  let incompleteInputTail = false;
  let played = startTimeSeconds === 0 && reuseMedia && !elements.video.paused;
  let suppressOutput = startTimeSeconds > 0;
  let seekSession = null;
  const reportedDamage = new Set();
  const externalDurationUs = liveMode ? null : BigInt(Math.round(
     durationSeconds(probeResult.duration) * 1000000));
  const presentationStartUs = liveMode ? 0n : timestampMicroseconds(
    probeResult.presentationStart);
  const presentationEndUs = liveMode ? null : timestampMicroseconds(
    probeResult.presentationEnd);
  let playbackFlow = createMsePlaybackFlowControl({
    media: playbackMedia,
    queues,
    requiredTracks,
    entryKind: liveMode ? 'live' : startTimeSeconds > 0 ? 'seek' : 'startup',
    entryTimeSeconds: startTimeSeconds,
    highSeconds: FORWARD_BUFFER_HIGH_SECONDS,
    lowSeconds: FORWARD_BUFFER_LOW_SECONDS,
    backBufferSeconds: BACK_BUFFER_SECONDS,
    queueHighBytes: SOURCE_QUEUE_HIGH_BYTES,
  });

  let msePipeline = null;
  let liveTransitionManager = null;
  let audioOnlyTransitionScheduled = false;
  const scheduleRecordedRebuild = (mode, target) => {
    if (audioOnlyTransitionScheduled || liveMode || generation !== runGeneration) return;
    audioOnlyTransitionScheduled = true;
    queueMicrotask(() => {
      if (generation !== runGeneration) return;
      appendLog(`${mode === MsePlaybackMode.AUDIO_ONLY ? '純音声' : 'A/V'} MediaSource を ` +
        `${target.toFixed(3)}s から再構築します（seek 読み込み上限 16 MiB）`);
      stopPlayback(true, false);
      void loadAndPlay(target, false, false, mode);
    });
  };
  const gapRecovery = createDemoPlaybackResilience({
    media: playbackMedia,
    mediaSource: () => mediaSource,
    queues: () => queues,
    playbackFlow: () => playbackFlow,
    pipeline: () => msePipeline,
    presentationStartUs,
    generation,
    initialMode: initialPlaybackMode,
    initialRestoreTarget: initialPlaybackMode === MsePlaybackMode.RESTORING_VIDEO
      ? startTimeSeconds : null,
    liveMode,
    isActive: () => generation === runGeneration && !suppressOutput,
    isCurrentLayer: damage => damage.videoTrackId === selectedVideo,
    switchInFlight: () => switchInFlight,
    seek: (target, previousTime, detail) => {
      internalSeekTarget = target;
      elements.video.currentTime = target;
      const presented = detail?.lastPresentedTime === null ||
        detail?.lastPresentedTime === undefined
        ? '不明' : `${detail.lastPresentedTime.toFixed(3)}s`;
      appendLog(`${liveMode ? 'Live 復帰' : '再生不能区間をスキップ'} ` +
        `${previousTime.toFixed(3)}s -> ${target.toFixed(6)}s ` +
          `(提示済み映像=${presented}, 最初の復旧RAP=${detail.firstRecoveryTime.toFixed(6)}s)`);
    },
    statusElement: elements.videoRecoveryStatus,
    playbackStateElement: elements.probeState,
    appendLog,
    scheduleRecordedRebuild,
    requestLiveTransition: (mode, target) => liveTransitionManager.transition(mode, target),
  });
  activeGapRecovery = gapRecovery;

  const maybeStartPlayback = () => {
    if (generation !== runGeneration ||
        playbackFlow.requiredTracks.some(type => !queues.has(type))) return;
    if (played) return;
    const started = startMsePlayback({
      media: elements.video,
      queues,
      liveMode,
      minimumLiveBufferSeconds: LIVE_STARTUP_BUFFER_SECONDS,
      requiredTracks: playbackFlow.requiredTracks,
    });
    if (!started) return;
    if (started.aligned) {
      internalSeekTarget = started.range.start;
      appendLog(`再生開始を共通バッファ先頭 ${started.range.start.toFixed(6)}s に合わせます`);
    }
    played = true;
    monitorPlaybackQuality(generation);
    elements.probeState.textContent = liveMode ? 'Live 再生中' : '再生中';
    if (liveMode) appendLog(`Live 共通バッファ ${started.commonAhead.toFixed(1)}s で再生開始 (1×)`);
    started.playResult.catch(() => {
      appendLog('自動再生がブロックされました。再生ボタンを押してください');
    });
  };
  const onMseUpdateEnd = () => {
    gapRecovery.notifyBufferedChange();
    maybeStartPlayback();
  };
  for (const queue of activeQueues) queue.onUpdateEnd = onMseUpdateEnd;

  msePipeline = createMseOutputPipeline({
    mediaSource,
    media: elements.video,
    queues,
    requiredTracks,
    onUpdateEnd: onMseUpdateEnd,
    queueOptions: {
      backBufferSeconds: BACK_BUFFER_SECONDS,
      forwardBufferHighSeconds: FORWARD_BUFFER_HIGH_SECONDS,
      getMediaError: media => mediaErrorMessage(media.error),
    },
    queueFactory(type, init, update, options) {
      let queue = activeQueueByType.get(type);
      if (queue && queue.mime !== init.mime) {
        throw new Error(`シーク中に ${type} codec が変化しました: ${queue.mime} -> ${init.mime}`);
      }
      if (!queue) queue = new MseAppendQueue(mediaSource, elements.video, init.mime, update, options);
      return queue;
    },
    onQueueCreated(type, queue) {
      activeQueueByType.set(type, queue);
      if (!activeQueues.includes(queue)) activeQueues.push(queue);
    },
    freshRecordedEntryAlignment: !liveMode && startTimeSeconds === 0 && !reuseMedia,
    recordedPresentationStartUs: liveMode ? null : presentationStartUs,
    onInitObserved: init => appendLog(`${init.type} 初期化 ${init.mime}`),
    onInitInstalled(init, _queue, reconfigured) {
      const details = init.type === 'video'
        ? `${init.width}x${init.height}`
        : `${init.sampleRate}Hz ${init.channels}ch`;
      if (reconfigured) {
        const expression = init.type === 'video' ? / · video [^·]+/ : / · audio [^·]+$/;
        elements.mediaInfo.textContent = elements.mediaInfo.textContent.replace(
          expression, ` · ${init.type} ${details}`);
      } else {
        elements.mediaInfo.textContent += ` · ${init.type} ${details}`;
      }
    },
    onFirstSegment: type => appendLog(`${type} media segment 開始`),
    onSplice: splice => appendLog(
      `${splice.type === 'video' ? '映像' : '音声'}バッファ切替 ` +
      `source=${splice.sourceBoundarySeconds.toFixed(6)}s ` +
      `output=${splice.outputBoundarySeconds.toFixed(6)}s`),
  });
  if (liveMode) {
    liveTransitionManager = createLiveMseTransitionManager({
      MediaSourceClass: BrowserMediaSource,
      media: playbackMedia,
      queueOptions: {
        backBufferSeconds: BACK_BUFFER_SECONDS,
        forwardBufferHighSeconds: FORWARD_BUFFER_HIGH_SECONDS,
        getMediaError: media => mediaErrorMessage(media.error),
      },
      isActive: () => generation === runGeneration,
      openMediaSource: openDetachedMediaSource,
      async commit(candidate) {
        if (generation !== runGeneration) return;
        const previousMedia = elements.video;
        const restoreMediaFocus = document.activeElement === previousMedia;
        const previousUrl = activeObjectUrl;
        const resume = !previousMedia.paused;
        const target = previousMedia.currentTime;
        const promotedMedia = candidate.probeMedia;
        promotedMedia.pause();
        for (const queue of queues.values()) queue.destroy();
        previousMedia.pause();
        promotedMedia.removeAttribute('aria-hidden');
        promotedMedia.removeAttribute('style');
        promotedMedia.controls = previousMedia.controls;
        promotedMedia.muted = previousMedia.muted;
        promotedMedia.volume = previousMedia.volume;
        promotedMedia.defaultPlaybackRate = previousMedia.defaultPlaybackRate;
        promotedMedia.playbackRate = previousMedia.playbackRate;
        previousMedia.removeAttribute('id');
        promotedMedia.id = 'video';
        previousMedia.replaceWith(promotedMedia);
        elements.video = promotedMedia;
        if (restoreMediaFocus) promotedMedia.focus({preventScroll: true});
        bindPlaybackMediaEvents(promotedMedia);
        dataBroadcast.setVideoElement(promotedMedia);
        hlgSdrRenderer.setVideoElement(promotedMedia);
        createSubtitleRenderer(liveMode);
        gapRecovery.notifyMediaElementChanged();
        mediaSource = candidate.mediaSource;
        queues = candidate.queues;
        playbackFlow = candidate.flow;
        msePipeline = candidate.pipeline;
        mediaSource.tlvdemuxQueues = queues;
        activeMediaSource = mediaSource;
        activeObjectUrl = candidate.url;
        activeQueueByType = new Map(queues);
        activeQueues = [...queues.values()];
        for (const queue of activeQueues) {
          queue.onUpdateEnd = onMseUpdateEnd;
          queue.resume();
        }
        promotedMedia.currentTime = Math.max(target, playbackFlow.entryRange()?.start ?? target);
        if (resume) await promotedMedia.play().catch(() => {});
        previousMedia.removeAttribute('src');
        previousMedia.load();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        appendLog(`Live ${candidate.mode === MsePlaybackMode.AUDIO_ONLY ? '純音声' : 'A/V'} ` +
          'MediaSource へ原子切替しました');
      },
      appendLog,
    });
    activeLiveTransitionManager = liveTransitionManager;
  }
  const onMseInit = init => {
    try {
      liveTransitionManager?.observeInit(init);
      msePipeline.onMseInit(init);
    }
    catch (error) { callbackError = error; }
  };
  const onMseSegment = segment => {
    try {
      liveTransitionManager?.observeSegment(segment);
      msePipeline.onMseSegment(segment);
    }
    catch (error) { callbackError = error; }
  };
  const onMseAudioSplice = splice => {
    try {
      liveTransitionManager?.observeSplice('audio', splice);
      msePipeline.onMseAudioSplice(splice);
    }
    catch (error) { callbackError = error; }
  };
  const onMseVideoSplice = splice => {
    try {
      liveTransitionManager?.observeSplice('video', splice);
      msePipeline.onMseVideoSplice(splice);
    }
    catch (error) { callbackError = error; }
  };
  const onMseLayerSwitch = layer => {
    try {
      const pending = pendingLayerSwitch;
      const video = pending?.video.trackId === layer.videoTrackId
        ? pending.video : tracks.get(layer.videoTrackId);
      const audio = pending?.audio.trackId === layer.audioTrackId
        ? pending.audio : tracks.get(layer.audioTrackId);
      pendingLayerSwitch = null;
      switchInFlight = false;
      if (!video || !audio) return;
      selectedVideo = video.trackId;
      selectedVideoTrack = video;
      selectedVideoPacketId = video.packetId;
      selectedAudio = audio.trackId;
      selectedAudioPacketId = audio.packetId;
      selectedAudioGroupId = pending?.groupIdentification ??
        audio.assetGroups?.find(group =>
          group.selectionLevel === selectionLevel(video))?.groupIdentification ?? null;
      renderVideoTracks();
      renderAudioTracks();
      appendLog(`${pending ? '' : '自動 · '}${videoTrackLabel(video)} へ切替完了 ` +
        `(映像=${(Number(layer.videoPresentationTimeUs) / 1000000).toFixed(6)}s, ` +
        `音声=${(Number(layer.audioPresentationTimeUs) / 1000000).toFixed(6)}s, ` +
        `packet_id=0x${audio.packetId.toString(16)})`);
      if (pending?.reason === 'source-damage' ||
          pending?.reason === 'health-degradation') {
        elements.playbackNotice.textContent = selectionLevel(video) > 0
          ? '通常映像の受信状態が悪いため、降雨対応映像で再生しています。通常映像が安定すると自動的に戻ります。'
          : '通常映像が安定したため、自動的に復帰しました。';
        elements.playbackNotice.hidden = false;
      }
    } catch (error) { callbackError = error; }
  };
  const onMseLayerSwitchCancelled = cancelled => {
    try {
      const pending = pendingLayerSwitch;
      pendingLayerSwitch = null;
      switchInFlight = false;
      renderVideoTracks();
      renderAudioTracks();
      const reason = {
        'end-of-input': '入力が終了するまでに切替先を準備できませんでした',
        reset: '再生状態がリセットされました',
        reposition: '再生位置が変更されました',
        'selection-changed': '別のトラックが選択されました',
      }[cancelled.reason] ?? '切替を完了できませんでした';
      const target = pending?.video ?? tracks.get(cancelled.videoTrackId);
      appendLog(`${pending ? '' : '自動 · '}${target ? videoTrackLabel(target) : '映像'} ` +
        `への切替を中止: ${reason}`);
    } catch (error) { callbackError = error; }
  };
  const onMseLayerSwitchStarted = started => {
    try {
      gapRecovery.notifyTrackSwitch(generation);
      switchInFlight = true;
      const video = tracks.get(started.videoTrackId);
      const audio = tracks.get(started.audioTrackId);
      if (!video || !audio) return;
      pendingLayerSwitch = {
        video,
        audio,
        groupIdentification: audio.assetGroups?.find(group =>
          group.selectionLevel === selectionLevel(video))?.groupIdentification ?? null,
        reason: started.reason,
      };
      const automatic = started.reason !== 'manual';
      appendLog(`${automatic ? '自動 · ' : ''}${videoTrackLabel(video)} への切替開始 ` +
        `(理由=${started.reason}, 最早=${(Number(started.earliestPresentationTimeUs) /
          1000000).toFixed(6)}s)`);
      if (started.reason === 'source-damage') {
        elements.playbackNotice.textContent =
          '通常映像の受信データが破損しているため、降雨対応映像へ切り替えています。通常映像が安定すると自動的に戻ります。 [TLV_SOURCE_DAMAGE]';
        elements.playbackNotice.hidden = false;
      }
    } catch (error) { callbackError = error; }
  };
  const onPlaybackDamage = damage => {
    try {
      gapRecovery.reportDamage(damage);
      if (damage.severity !== 'severe' && damage.action !== 'seek-if-stalled') return;
      const start = Number(
        BigInt(damage.startTimeUs ?? damage.endTimeUs) - presentationStartUs,
      ) / 1000000;
      const recovery = damage.recoveryTimeUs === null
        ? null : Number(BigInt(damage.recoveryTimeUs) - presentationStartUs) / 1000000;
      const key = `${damage.videoTrackId}:${damage.startInputOffset}:${damage.endInputOffset}`;
      if (reportedDamage.has(key)) return;
      reportedDamage.add(key);
      if (recovery !== null) {
        elements.playbackNotice.textContent =
          `録画データの一部が破損しているため、再生が止まった場合は ` +
          `次の利用可能な復旧点へ自動的に移動します。` +
          ` [${damage.code}]`;
        const prefetched = start > elements.video.currentTime + 0.5 ? '（先読み）' : '';
        appendLog(`映像損傷${prefetched} 再生時間 ${start.toFixed(3)}s -> ` +
          `${recovery.toFixed(3)}s、` +
          `停止時に復旧点へスキップします [${damage.code}]`);
      } else {
        elements.playbackNotice.textContent = liveMode
          ? `受信データの破損により映像を復号できません。次の復旧点を待っています。 ` +
            `[${damage.code}]`
          : `録画末尾の破損により、これ以降の映像を復号できません。 ` +
            `[${damage.code}]`;
        appendLog(`映像損傷 復旧点なし [${damage.code}]`);
      }
      elements.playbackNotice.hidden = false;
    } catch (error) { callbackError = error; }
  };
  const wantedVideoPacketId = parsePacketId();
  const initialVideoPacketId = wantedVideoPacketId ?? probeResult.videoPacketId ?? undefined;
  videoSelectionMode = automaticLayerSwitchEnabled(wantedVideoPacketId)
    ? 'auto' : 'fixed';

  const refreshAutomaticLayerPair = () => {
    if (!demuxer) return Promise.resolve(null);
    const currentAudio = [...knownAudioTracks.values()].find(
      track => track.trackId === selectedAudio,
    );
    const pair = selectedVideoTrack && currentAudio ? resolveLayerPair(
      [...knownVideoTracks.values(), ...knownAudioTracks.values()],
      selectedVideoTrack, currentAudio, selectedAudioGroupId,
    ) : null;
    const update = automaticLayerPairUpdate.then(async () => {
      const previous = automaticLayerPairSignature;
      const signature = await configureSdkAutomaticLayerPair(
        demuxer, pair, previous, {manual: videoSelectionMode === 'fixed'},
      );
      automaticLayerPairSignature = signature;
      if (pair?.fallback && signature !== previous) {
        appendLog(`C++ 降雨対応候補を登録（切替未実行） ` +
          `0x${pair.preferred.video.packetId.toString(16)} ↔ ` +
          `0x${pair.fallback.video.packetId.toString(16)}`);
      }
      return signature;
    });
    automaticLayerPairUpdate = update.catch(error => { callbackError = error; });
    return update;
  };

  const selectAudioTrack = (track, groupIdentification = null) => {
    selectedAudio = track.trackId;
    selectedAudioPacketId = track.packetId;
    selectedAudioGroupId = groupIdentification ??
      track.assetGroups?.[0]?.groupIdentification ?? null;
    void demuxer.selectTrack('audio', selectedAudio);
    renderAudioTracks();
    refreshAutomaticLayerPair();
  };

  const synchronizeAudioForVideoLayer = () => {
    const targetLevel = selectionLevel(selectedVideoTrack);
    if (targetLevel === null) return;
    const availableAudioTracks = [...tracks.values()].filter(track => track.kind === 'audio');
    const currentTrack = availableAudioTracks.find(
      track => track.trackId === selectedAudio,
    ) || preferredMseAudioTrack(
      new Map(availableAudioTracks.map(track => [track.packetId, track])),
      preferredAudioPacketId,
    );
    // A coordinated layer switch chooses its audio explicitly. Do not race it
    // with an independent audio switch merely because track metadata repeated.
    if (pendingLayerSwitch) return;
    const corresponding = correspondingAudioTrack(
      availableAudioTracks, currentTrack, targetLevel, selectedAudioGroupId,
    );
    if (!corresponding || !mseAudioTrackSupported(corresponding.track)) return;
    selectedAudioGroupId = corresponding.groupIdentification;
    if (corresponding.track.trackId === selectedAudio) return;
    appendLog(`階層映像 selection_level=${targetLevel} に対応する音声 ` +
      `packet_id=0x${corresponding.track.packetId.toString(16)} を選択します`);
    if (activeAudioSwitch) {
      activeAudioSwitch(
        corresponding.track.packetId, corresponding.groupIdentification,
      ).catch(error => {
        appendLog(`階層音声切替エラー ${error.message || error}`);
        console.error(error);
      });
    } else {
      selectAudioTrack(corresponding.track, corresponding.groupIdentification);
    }
  };

  const selectSubtitleTrack = track => {
    if (subtitleTrackKind(track) !== 'caption') {
      throw new Error('文字スーパーは字幕トラックとして選択できません');
    }
    const previousTrack = tracks.get(selectedSubtitle);
    selectedSubtitle = track.trackId;
    selectedSubtitlePacketId = track.packetId;
    void demuxer.selectTrack('subtitle', selectedSubtitle);
    if (previousTrack && previousTrack.trackId !== track.trackId) {
      activeSubtitleRenderer?.clearTrack(previousTrack.packetId);
    }
    renderSubtitleTracks();
  };

  let demuxer;
  demuxer = new wasmModule.TlvDemuxer({
    mseMaxAudioChannels: MSE_MAX_AUDIO_CHANNELS,
    onMseVideoStart(detail) {
      appendLog(`映像開始 HEVC NAL=${detail.nalType} シグナルRAP=${detail.signalledRandomAccess}`);
    },
    onMseVideoProperties(properties) {
      currentVideoProperties = properties;
      updateVideoColorStatus();
      const sourceTransfer = properties.sourceColor?.transfer ?? '不明';
      const outputTransfer = properties.outputColor?.transfer ?? '不明';
      appendLog(`映像属性更新 PTS=${properties.presentationTimeUs}us ` +
        `入力transfer=${sourceTransfer} 出力transfer=${outputTransfer} ` +
        `SDR解釈=${properties.sdrInHlg ? '有効' : '無効'}`);
    },
    onMseInit,
    onMseSegment,
    onMseAudioSplice,
    onMseVideoSplice,
    onMseLayerSwitchStarted,
    onMseLayerSwitch,
    onMseLayerSwitchCancelled,
    onPlaybackDamage,
    onTrack(track) {
      tracks.set(track.trackId, track);
      seekSession?.observeTrack(track);
      appendLog(`トラック ${track.kind} packet_id=0x${track.packetId.toString(16)} codec=${track.codec}`);
      if (track.kind === 'video') {
        knownVideoTracks.set(track.packetId, track);
        renderVideoTracks();
        const previousGroup = selectedVideoTrack?.assetGroups?.[0];
        const matchingReplacement = selectedVideo === null && selectedVideoTrack &&
          track.contextId === selectedVideoTrack.contextId &&
          (track.componentTag === selectedVideoTrack.componentTag ||
            track.assetGroups?.some(group =>
              group.groupIdentification === previousGroup?.groupIdentification &&
              group.selectionLevel === previousGroup?.selectionLevel));
        if (selectedVideo === null &&
            (matchingReplacement ||
             (initialVideoPacketId === undefined || track.packetId === initialVideoPacketId))) {
          selectedVideo = track.trackId;
          selectedVideoTrack = track;
          selectedVideoPacketId = track.packetId;
          void demuxer.selectTrack('video', selectedVideo);
          renderVideoTracks();
          if (startTimeSeconds > 0 && track.packetId === initialVideoPacketId) {
            appendLog(`${videoTrackLabel(track)} をシーク用映像層として選択します`);
          }
          synchronizeAudioForVideoLayer();
        }
      } else if (track.kind === 'audio') {
        knownAudioTracks.set(track.packetId, track);
        renderAudioTracks();
        if (!mseAudioTrackSupported(track)) {
          appendLog(`音声 packet_id=0x${track.packetId.toString(16)} ` +
            `${track.audio?.channels ?? '?'}ch は MSE 上限 ` +
            `${MSE_MAX_AUDIO_CHANNELS}ch を超えるため除外します`);
          if (selectedAudio === track.trackId) {
            selectedAudio = null;
            void demuxer.selectTrack('audio', undefined);
            const fallback = preferredMseAudioTrack(
              knownAudioTracks, preferredAudioPacketId,
            );
            if (fallback) {
              appendLog(`互換音声 packet_id=0x${fallback.packetId.toString(16)} に切り替えます`);
              selectAudioTrack(fallback);
            }
          }
          return;
        }
        const desired = preferredAudioPacketId ?? selectedAudioPacketId;
        const targetLevel = selectionLevel(selectedVideoTrack);
        const restoresSelectedGroup = selectedAudio === null && selectedAudioGroupId !== null &&
          track.assetGroups?.some(group =>
            group.groupIdentification === selectedAudioGroupId &&
            (targetLevel === null || group.selectionLevel === targetLevel));
        if (restoresSelectedGroup ||
            (selectedAudioGroupId === null &&
             (selectedAudio === null || track.packetId === desired))) {
          selectAudioTrack(track, restoresSelectedGroup ? selectedAudioGroupId : null);
        }
        synchronizeAudioForVideoLayer();
      } else if (track.kind === 'subtitle' && track.codec === 'ttml') {
        const trackKind = subtitleTrackKind(track);
        knownTtmlTracks.set(track.packetId, track);
        dataBroadcast.captionTrackChanged(track);
        appendLog(`${trackKind === 'caption' ? '字幕' : '文字スーパー'} ` +
          `packet_id=0x${track.packetId.toString(16)} type=${track.subtitle.type} ` +
          `display=${track.subtitle.displayMode}`);
        if (trackKind === 'caption') {
          knownSubtitleTracks.set(track.packetId, track);
          renderSubtitleTracks();
          const desired = preferredSubtitlePacketId ?? selectedSubtitlePacketId;
          if (selectedSubtitle === null || track.packetId === desired) selectSubtitleTrack(track);
        }
      }
      refreshAutomaticLayerPair();
    },
    onTrackRemoved(track) {
      seekSession?.observeTrackRemoved(track);
      if (pendingLayerSwitch &&
          (track.trackId === pendingLayerSwitch.video.trackId ||
           track.trackId === pendingLayerSwitch.audio.trackId)) {
        appendLog(`${videoTrackLabel(pendingLayerSwitch.video)} への切替先が消えたため中止します`);
        void demuxer.selectTrack('video', selectedVideo).catch(error => {
          appendLog(`レイヤー切替中止エラー ${error.message || error}`);
        });
      }
      tracks.delete(track.trackId);
      if (track.kind === 'video') {
        const removedSelectedVideo = selectedVideo === track.trackId;
        knownVideoTracks.delete(track.packetId);
        if (removedSelectedVideo) {
          selectedVideo = null;
          selectedVideoTrack = null;
        }
        renderVideoTracks();
      } else if (track.kind === 'audio') {
        knownAudioTracks.delete(track.packetId);
        if (selectedAudio === track.trackId) selectedAudio = null;
        renderAudioTracks();
      } else if (track.kind === 'subtitle') {
        knownTtmlTracks.delete(track.packetId);
        knownSubtitleTracks.delete(track.packetId);
        if (selectedSubtitle === track.trackId) selectedSubtitle = null;
        renderSubtitleTracks();
      }
      if (track.kind === 'video' || track.kind === 'audio') {
        automaticLayerPairSignature = null;
        refreshAutomaticLayerPair();
      }
    },
    onBroadcastClock(clock) {
      try { dataBroadcast.broadcastClockChanged(clock); }
      catch (error) { callbackError = error; }
    },
    onEventInfo(event) {
      try {
        if (Number(event.tableId) === 0x8b && event.currentNext &&
            Number(event.sectionNumber) === 0 &&
            currentVideoPresentationHint !== event.videoPresentationHint) {
          currentVideoPresentationHint = event.videoPresentationHint;
          updateVideoColorStatus();
          appendLog(event.videoPresentationHint === 'hdr'
            ? '現在の番組に HDR マークがあります：ブラウザの HLG 表示を維持します'
            : '現在の番組に明確な SDR/HDR マークがありません：元の映像信号を維持します');
        }
        dataBroadcast.eventInformationChanged(event);
      }
      catch (error) { callbackError = error; }
    },
    onViewerParticipationNotification(notification) {
      dataBroadcast.viewerParticipationChanged(notification);
    },
    onApplicationResourceView(resource) {
      try { dataBroadcast.resourceChanged(resource); }
      catch (error) { callbackError = error; }
    },
    onApplicationState(state) {
      try { dataBroadcast.applicationStateChanged(demuxer, state); }
      catch (error) { callbackError = error; }
    },
    onApplicationResourcesReset() {
      dataBroadcast.resourcesReset();
    },
    onPlaybackAccessUnitView(unit) {
      try {
        seekSession?.observeAccessUnit(unit);
        gapRecovery.observeAccessUnit(unit);
        const subtitleTrack = tracks.get(unit.trackId);
        if (!suppressOutput && unit.codec === 'ttml' && subtitleTrack?.kind === 'subtitle') {
          dataBroadcast.captionDataChanged(unit);
        }
        if (unit.trackId === selectedVideo) {
          if (unit.discontinuity) {
            videoDiscontinuityCount += 1;
            appendLog(`video discontinuity #${videoDiscontinuityCount} ` +
              `PTS=${(Number(unit.ptsValue) / unit.ptsTimescale).toFixed(6)}s ` +
              `RAP=${unit.randomAccess}`);
          }
        } else if (unit.trackId === selectedAudio) {
          if (unit.discontinuity) {
            audioDiscontinuityCount += 1;
            appendLog(`audio discontinuity #${audioDiscontinuityCount} ` +
              `PTS=${(Number(unit.ptsValue) / unit.ptsTimescale).toFixed(6)}s`);
          }
        } else if (unit.codec === 'ttml' && subtitleTrack?.kind === 'subtitle' &&
            !suppressOutput) {
          const track = tracks.get(unit.trackId);
          if (!track || !activeSubtitleRenderer) return;
          const trackKind = subtitleTrackKind(track);
          if (!shouldRenderSubtitleTrack(track, selectedSubtitle)) return;
          if (unit.discontinuity) activeSubtitleRenderer.clearTrack(track.packetId);
          const subtitleData = {
            packetId: track.packetId,
            trackKind,
            subtitleType: track.subtitle.type,
            subtitleOperationMode: track.subtitle.operationMode,
            mpuSequenceNumber: unit.mpuSequenceNumber ?? undefined,
            pts: timestampMilliseconds(unit.ptsValue, unit.ptsTimescale),
            dts: timestampMilliseconds(unit.dtsValue, unit.dtsTimescale),
            subtitleTimingMode: unit.subtitleTimingMode ?? track.subtitle?.timingMode,
            subtitleOperationMode: unit.subtitleOperationMode ?? track.subtitle.operationMode,
            subtitleDisplayMode: unit.subtitleDisplayMode ?? track.subtitle.displayMode,
            subtitleCompressionType: unit.subtitleCompressionType ?? track.subtitle.compressionType,
            subtitleReferenceStartMediaTime: timestampMilliseconds(
              unit.subtitleReferenceStartPtsValue,
              unit.subtitleReferenceStartPtsTimescale,
            ),
            data: unit.data,
            len: unit.data.byteLength,
            resources: (unit.subtitleResources || []).map(resource => ({
              index: resource.subsampleNumber,
              dataType: resource.dataType,
              data: resource.data,
            })),
          };
          const result = activeSubtitleRenderer.push(subtitleData);
          subtitleEventCount += 1;
          if (subtitleEventCount <= 8) {
            appendLog(`${trackKind === 'caption' ? '字幕' : '文字スーパー'} ` +
              `#${subtitleEventCount} packet_id=0x${track.packetId.toString(16)}` +
              ` cues=${result.cueCount} resources=${result.resourceCount}` +
              ` pts=${subtitleData.pts?.toFixed(3) ?? '—'}ms`);
          }
        }
      } catch (error) { callbackError = error; }
    },
    onError(error) {
      if (!error.recoverable) callbackError = new Error(error.message);
      else {
        if (/^incomplete TLV (header|payload) at end of input$/.test(error.message)) {
          incompleteInputTail = true;
        }
        if (recoverableErrors++ < 8) appendLog(`分離警告 @${error.inputOffset}: ${error.message}`);
      }
    },
  });
  [currentHlgSdrLut, prototypeHlgSdrLut] = await Promise.all([
    demuxer.hlgSdrColorLut(), demuxer.hlgSdrPrototypeColorLut(),
  ]);
  setHlgSdrLut(currentToneMappingMode === 'prototype'
    ? prototypeHlgSdrLut : currentHlgSdrLut);
  await demuxer.configureTrackSelection({
    videoPacketId: initialVideoPacketId,
    audioPacketId: preferredAudioPacketId,
    subtitlePacketId: preferredSubtitlePacketId,
  });
  await demuxer.setMseToneMappingMode(effectiveToneMappingMode());
  await demuxer.setSubtitlePassthroughEnabled(true);
  if (!liveMode) await demuxer.setMseTimestampOffset(-presentationStartUs);
  await demuxer.setMseOutputEnabled(!suppressOutput);
  activeDemuxer = demuxer;
  activeVideoSwitch = async (packetId, earliestUs = null) => {
    gapRecovery.notifyTrackSwitch(generation);
    const track = knownVideoTracks.get(packetId);
    if (!track) throw new Error(`映像 packet_id=0x${packetId.toString(16)} は利用できません`);
    if (track.trackId === selectedVideo) return;
    if (pendingLayerSwitch) throw new Error('別の映像レイヤー切替が進行中です');
    const currentAudio = [...knownAudioTracks.values()].find(
      candidate => candidate.trackId === selectedAudio,
    );
    const corresponding = correspondingAudioTrack(
      knownAudioTracks.values(), currentAudio, selectionLevel(track), selectedAudioGroupId,
    );
    if (!corresponding) {
      throw new Error('切替先の映像レイヤーに対応する音声がありません');
    }
    const mediaEntryUs = BigInt(Math.round((playbackFlow.entryCovered()
      ? elements.video.currentTime + 0.1
      : playbackFlow.entryTimeSeconds) * 1000000));
    const earliest = earliestUs ?? presentationStartUs + mediaEntryUs;
    pendingLayerSwitch = {
      video: track,
      audio: corresponding.track,
      groupIdentification: corresponding.groupIdentification,
      reason: 'manual',
    };
    const accepted = playbackFlow.entryCovered()
      ? await demuxer.switchLayer(track.trackId, corresponding.track.trackId, earliest)
      : await demuxer.switchLayerAtPlaybackEntry(
        track.trackId, corresponding.track.trackId, mediaEntryUs,
      );
    if (!accepted) {
      pendingLayerSwitch = null;
      throw new Error('映像レイヤー切替を開始できませんでした');
    }
    appendLog(`${videoTrackLabel(track)} を次の RAP で切り替えます`);
  };
  activeVideoSelectionMode = async packetId => {
    if (packetId === null) {
      elements.videoPacketId.value = '';
      videoSelectionMode = 'auto';
      try {
        await refreshAutomaticLayerPair();
        renderVideoTracks();
        appendLog('映像レイヤーを自動選択に戻し、状態を再評価しました');
      } catch (error) {
        videoSelectionMode = 'fixed';
        elements.videoPacketId.value = selectedVideoPacketId === null
          ? '' : String(selectedVideoPacketId);
        await refreshAutomaticLayerPair();
        renderVideoTracks();
        throw error;
      }
      return;
    }
    elements.videoPacketId.value = String(packetId);
    videoSelectionMode = 'fixed';
    await refreshAutomaticLayerPair();
    if (pendingLayerSwitch && selectedVideo !== null) {
      await demuxer.selectTrack('video', selectedVideo);
    }
    const target = knownVideoTracks.get(packetId);
    if (target?.trackId === selectedVideo) {
      renderVideoTracks();
      appendLog(`${videoTrackLabel(target)} を固定選択に設定しました`);
      return;
    }
    await activeVideoSwitch(packetId);
  };
  activeAudioSwitch = async (packetId, groupIdentification = null, earliestUs = null) => {
    gapRecovery.notifyTrackSwitch(generation);
    let track = [...tracks.values()].find(
      item => item.kind === 'audio' && item.packetId === packetId,
    );
    if (!track) throw new Error(`音声 packet_id=0x${packetId.toString(16)} は利用できません`);
    if (groupIdentification !== null) {
      const layered = correspondingAudioTrack(
        knownAudioTracks.values(), track, selectionLevel(selectedVideoTrack), groupIdentification,
      );
      if (layered) track = layered.track;
    }
    if (!mseAudioTrackSupported(track)) {
      throw new Error(`音声 packet_id=0x${packetId.toString(16)} の ` +
        `${track.audio?.channels ?? '?'}ch は MSE 非対応です`);
    }
    if (track.trackId === selectedAudio) {
      if (groupIdentification !== null) selectedAudioGroupId = groupIdentification;
      return;
    }
    if (suppressOutput) {
      selectAudioTrack(track, groupIdentification);
      return;
    }
    if (generation !== runGeneration) return;
    const earliest = earliestUs ??
      presentationStartUs + BigInt(Math.round((elements.video.currentTime + 0.1) * 1000000));
    const preparationDeadline = earliestUs === null ? 0 : performance.now() + 3000;
    let boundary = null;
    do {
      boundary = await demuxer.switchAudioTrack(track.trackId, earliest);
      if (boundary !== null || preparationDeadline === 0 ||
          performance.now() >= preparationDeadline || generation !== runGeneration) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    if (callbackError) throw callbackError;
    if (boundary === null) {
      throw new Error('切替先の音声が現在の再生位置まで準備できていません');
    }
    if (generation !== runGeneration) return;
    selectedAudio = track.trackId;
    selectedAudioPacketId = track.packetId;
    selectedAudioGroupId = groupIdentification ??
      track.assetGroups?.[0]?.groupIdentification ?? null;
    appendLog(`音声切替 packet_id=0x${track.packetId.toString(16)} (インプレース)`);
    renderAudioTracks();
  };
  activeSubtitleSwitch = packetId => {
    const track = [...tracks.values()].find(
      item => item.kind === 'subtitle' && item.subtitle?.type === 0 && item.packetId === packetId,
    );
    if (!track) throw new Error(`字幕 packet_id=0x${packetId.toString(16)} は利用できません`);
    if (track.trackId === selectedSubtitle) return;
    selectSubtitleTrack(track);
    appendLog(`字幕切替 packet_id=0x${packetId.toString(16)}`);
  };
  if (!liveMode) await demuxer.startIndex(false);
  elements.mediaInfo.textContent = 'tlvdemux';
  elements.probeState.textContent = 'バッファリング中';

  let offset = 0n;
  let playbackBytes = 0n;
  let lastReported = 0n;
  if (startTimeSeconds > 0) {
    seekSession = createMseRecordedSeekSession({
      targetTimeSeconds: startTimeSeconds,
      source,
      durationUs: externalDurationUs,
      presentationStartUs,
      presentationEndUs,
      demuxer,
      media: elements.video,
      queues,
      flowControl: playbackFlow,
      signal: activeController?.signal,
      isActive: () => generation === runGeneration,
      requiredTracks,
      headReady: () => requiredTracks.length === 1
        ? selectedAudio !== null : selectedVideo !== null,
      candidateTrack: track => requiredTracks.length === 1
        ? track.kind === 'audio' && track.trackId === selectedAudio
        : track.kind === 'video' &&
          (track.trackId === selectedVideo || sameVideoLayerGroup(selectedVideoTrack, track)),
      trackPriority: track => track.kind === 'video' ? selectionLevel(track) ?? 0xff : 0,
      activateVideoTrack: async track => {
        if (requiredTracks.length === 1) {
          if (track && track.trackId !== selectedAudio) selectAudioTrack(track);
          return;
        }
        if (!track || track.trackId === selectedVideo) return;
        selectedVideo = track.trackId;
        selectedVideoTrack = track;
        selectedVideoPacketId = track.packetId;
        await demuxer.selectTrack('video', selectedVideo);
        const currentAudio = [...tracks.values()].find(
          candidate => candidate.kind === 'audio' && candidate.trackId === selectedAudio,
        );
        const corresponding = correspondingAudioTrack(
          [...tracks.values()].filter(candidate => candidate.kind === 'audio'),
          currentAudio, selectionLevel(track), selectedAudioGroupId,
        );
        if (corresponding) {
          selectAudioTrack(corresponding.track, corresponding.groupIdentification);
          await demuxer.selectTrack('audio', corresponding.track.trackId);
        }
        renderVideoTracks();
        appendLog(`シーク位置では ${videoTrackLabel(track)} を選択します`);
      },
      beforeLanding: async () => {
        suppressOutput = false;
        if (!reuseMedia) {
          internalSeekTarget = startTimeSeconds;
          elements.video.currentTime = startTimeSeconds;
        }
      },
      waitForAppends: async () => {
        await Promise.all([...queues.values()].map(queue => queue.waitStable()));
      },
      checkError: () => { if (callbackError) throw callbackError; },
      onProgress: progress => {
        playbackBytes = progress.bytesRead;
        elements.transferred.textContent =
          `${formatBytes(probeResult.transferred + playbackBytes)} / seek 16 MiB`;
      },
    });
    const result = await seekSession.run();
    if (generation !== runGeneration) return;
    offset = result.nextOffset;
    playbackBytes = result.bytesRead;
    appendLog(`シーク ${startTimeSeconds.toFixed(3)}s -> 推定 ` +
      `${formatBytes(result.estimateOffset)}、RAP ` +
      `${(Number(result.rapPresentationTimeUs) / 1000000).toFixed(3)}s @ ` +
      `${formatBytes(result.restartOffset)}、総読み込み ${formatBytes(result.bytesRead)}`);
  }
  if (liveMode && source.stream) {
    for await (const data of source.stream()) {
      if (generation !== runGeneration) return;
      const dataLength = BigInt(data.byteLength);
      await demuxer.setMsePlaybackPosition(
        BigInt(Math.round(elements.video.currentTime * 1000000)));
      if (!await demuxer.push(data)) {
        throw new Error(`Live 分離入力に失敗しました: ${playbackBytes}`);
      }
      if (callbackError) throw callbackError;
      await playbackFlow.afterPush(data.byteLength, () => generation === runGeneration);
      playbackBytes += dataLength;
      elements.transferred.textContent =
        `${formatBytes(playbackBytes)} / ${playbackFlow.commonAhead().toFixed(1)}s`;
      if (playbackBytes - lastReported >= 32n * MiB) {
        appendLog(`Live ${formatBytes(playbackBytes)}、` +
          `共通バッファ=${playbackFlow.commonAhead().toFixed(1)}s`);
        lastReported = playbackBytes;
      }
    }
  }
  while ((!liveMode || !source.stream) && offset < source.size && generation === runGeneration) {
    const length = source.size - offset < PLAYBACK_CHUNK
      ? source.size - offset : PLAYBACK_CHUNK;
    const data = await source.read(offset, length);
    if (generation !== runGeneration) return;
    await demuxer.setMsePlaybackPosition(
      BigInt(Math.round(elements.video.currentTime * 1000000)));
    if (!await demuxer.push(data)) throw new Error(`分離入力に失敗しました: ${offset}`);
    if (callbackError) throw callbackError;
    await playbackFlow.afterPush(data.byteLength, () => generation === runGeneration);
    offset += length;
    playbackBytes += length;
    elements.transferred.textContent = `${formatBytes(probeResult.transferred + playbackBytes)} / ` +
      `${playbackFlow.commonAhead().toFixed(1)}s`;
    if (playbackBytes - lastReported >= 32n * MiB || offset === source.size) {
      appendLog(`再生 ${formatBytes(offset)} / ${formatBytes(source.size)}、` +
        `共通バッファ=${playbackFlow.commonAhead().toFixed(1)}s`);
      lastReported = playbackBytes;
    }
  }
  if (generation !== runGeneration) return;
  liveTransitionManager?.destroy();
  if (activeLiveTransitionManager === liveTransitionManager) {
    activeLiveTransitionManager = null;
  }
  gapRecovery.notifySourceEnded();
  await demuxer.flush();
  if (callbackError) throw callbackError;
  if (!liveMode) await demuxer.finalizeIndex();
  const [seekPointCount, indexState] = await Promise.all([
    demuxer.seekPointCount(), demuxer.indexState(),
  ]);
  appendLog(`索引 RAP ${seekPointCount} 点、状態=${indexState}`);
  demuxer.delete();
  activeDemuxer = null;
  activeAudioSwitch = null;
  activeVideoSwitch = null;
  activeVideoSelectionMode = null;
  activeSubtitleSwitch = null;
  if (generation !== runGeneration) return;
  const finalized = await msePipeline.finalize({
    truncateToCommonEnd: !liveMode && incompleteInputTail,
  });
  if (finalized.truncatedTo !== null) {
    appendLog(`不完全な入力末尾を共通 A/V 終端 ${finalized.truncatedTo.toFixed(6)}s に丸めました`);
  }
  elements.probeState.textContent = liveMode ? 'Live 終了' : '読み込み完了';
  appendLog(liveMode ? 'Live ストリームが終了しました' : 'ストリーム終端です');
}

async function loadAndPlay(startTimeSeconds = 0, reuseMedia = false,
                           initialLoad = false,
                           initialPlaybackMode = MsePlaybackMode.AUDIO_VIDEO) {
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
      source, probeResult, generation, startTimeSeconds, liveMode, reuseMedia,
      initialPlaybackMode,
    );
  } catch (error) {
    if (generation !== runGeneration || error.name === 'AbortError') return;
    elements.probeState.textContent = '失敗';
    elements.mediaInfo.textContent = error.message || String(error);
    appendLog(`エラー ${error.message || error}`);
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
    activeController?.abort();
  }, options);
  media.addEventListener('waiting', () => {
    appendLog(`MediaElement waiting ${media.currentTime.toFixed(3)}s`);
    activeGapRecovery?.notifyWaiting();
  }, options);
  media.addEventListener('seeking', () => {
    if (currentLiveMode || !activeMediaSource) return;
    const target = media.currentTime;
    if (internalSeekTarget !== null && Math.abs(target - internalSeekTarget) < 0.1) return;
    internalSeekTarget = null;
    activeGapRecovery?.notifyExplicitSeek(runGeneration);
    const currentVideoTrack = knownVideoTracks.get(selectedVideoPacketId);
    const automaticFallbackActive = shouldReprobeVideoLayerForSeek(
      currentVideoTrack, parsePacketId());
    if (isTimeBuffered(target) && !automaticFallbackActive) return;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      if (!activeMediaSource) return;
      appendLog(`ユーザーシーク ${target.toFixed(3)}s` +
        (automaticFallbackActive ? '、映像層を再評価します' : ''));
      // A SourceBuffer that has already changed from the preferred 4K decoder
      // configuration to the rainfall 1080p configuration is unsafe to reuse
      // for a backwards seek into 4K. Chromium retains per-frame decoder config
      // history, and overlapping the old timeline can eventually surface as
      // VideoToolbox -17694. Rebuild MSE only for this cross-layer seek.
      const reuseMedia = !automaticFallbackActive;
      stopPlayback(true, reuseMedia);
      loadAndPlay(target, reuseMedia);
    }, 120);
  }, options);
  media.addEventListener('seeked', () => {
    if (internalSeekTarget !== null &&
        Math.abs(media.currentTime - internalSeekTarget) < 0.1) {
      internalSeekTarget = null;
    }
    activeGapRecovery?.notifyBufferedChange();
  }, options);
}

bindPlaybackMediaEvents(elements.video);

createWorkerTlvDemuxModule().then(module => {
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
