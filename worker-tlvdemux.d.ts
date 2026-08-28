import createTlvDemuxModule = require('./index');

export interface WorkerTlvDemuxModuleOptions {
  workerUrl?: string | URL;
  wasmUrl?: string;
  workerFactory?: (url: string | URL) => Worker;
}

export interface WorkerDemuxerObjectOptions {
  videoPacketId?: number | null;
  audioPacketId?: number | null;
  subtitlePacketId?: number | null;
  mseMaxAudioChannels?: number;
  indexDurationUs?: bigint | null;
}

export declare const TLV_DEMUX_WORKER_PROTOCOL: Readonly<{
  init: 'tlvdemux:init'; ready: 'tlvdemux:ready'; create: 'tlvdemux:create';
  invoke: 'tlvdemux:invoke'; destroy: 'tlvdemux:destroy'; result: 'tlvdemux:result';
  event: 'tlvdemux:event'; failure: 'tlvdemux:failure';
}>;

export declare function workerResultValue(message: {value?: unknown}): unknown;

export interface WorkerDurationProbe {
  begin(size: bigint, options?: createTlvDemuxModule.DurationProbeOptions): Promise<boolean>;
  nextRange(): Promise<createTlvDemuxModule.RangeRequest | null>;
  failRange(requestId: bigint): Promise<boolean>;
  cancel(): Promise<void>;
  state(): Promise<createTlvDemuxModule.DurationProbeState>;
  failure(): Promise<createTlvDemuxModule.DurationProbeFailure>;
  duration(): Promise<createTlvDemuxModule.DurationInfo | null>;
  selectedVideoPacketId(): Promise<number | null>;
  transferredBytes(): Promise<bigint>;
  pushRange(requestId: bigint, offset: bigint, bytes: Uint8Array, endOfRange: boolean): Promise<boolean>;
  isDeleted(): boolean;
  delete(): void;
}

export interface WorkerDemuxer {
  initialized(): Promise<void>;
  configureTrackSelection(options: Record<string, unknown>): Promise<unknown>;
  push(bytes: Uint8Array): Promise<boolean>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  reposition(offset: bigint, preserveTimeline: boolean): Promise<void>;
  selectService(contextId?: number | null): Promise<void>;
  selectTrack(kind: createTlvDemuxModule.TrackKind, trackId?: bigint | null): Promise<void>;
  switchAudioTrack(trackId: bigint, earliestPresentationTimeUs: bigint): Promise<bigint | null>;
  switchLayer(videoTrackId: bigint, audioTrackId: bigint, earliestPresentationTimeUs: bigint): Promise<boolean>;
  configureAutomaticLayerSwitch(preferredVideoTrackId: bigint, preferredAudioTrackId: bigint, fallbackVideoTrackId: bigint, fallbackAudioTrackId: bigint): Promise<void>;
  suspendAutomaticLayerSwitch(): Promise<void>;
  clearAutomaticLayerSwitch(): Promise<void>;
  setMsePlaybackPosition(presentationTimeUs: bigint): Promise<void>;
  setMseSdrInHlg(videoTrackId: bigint, enabled: boolean): Promise<void>;
  setMseToneMappingMode(mode: createTlvDemuxModule.MseToneMappingMode): Promise<void>;
  setMseEdid(edid: Uint8Array): Promise<void>;
  setMseOutputConnected(connected: boolean): Promise<void>;
  hlgSdrToneMappingLut(): Promise<Uint8Array>;
  hlgSdrColorLut(): Promise<createTlvDemuxModule.HlgSdrColorLut>;
  hlgSdrPrototypeColorLut(): Promise<createTlvDemuxModule.HlgSdrColorLut>;
  setMseOutputEnabled(enabled: boolean): Promise<void>;
  setSubtitlePassthroughEnabled(enabled: boolean): Promise<void>;
  startIndex(growing: boolean): Promise<void>;
  finalizeIndex(): Promise<boolean>;
  setIndexDuration(durationUs: bigint): Promise<boolean>;
  estimateOffset(targetUs: bigint, sourceSize: bigint): Promise<bigint | null>;
  seekPointCount(): Promise<number>;
  indexState(): Promise<createTlvDemuxModule.IndexState>;
  applicationEntry(contextId: number): string | null;
  applications(): createTlvDemuxModule.ApplicationState[];
  broadcastClock(): createTlvDemuxModule.BroadcastClock | null;
  layoutConfiguration(): createTlvDemuxModule.LayoutConfiguration | null;
  applicationResources(contextId?: number): createTlvDemuxModule.ApplicationResourceMetadata[];
  applicationResource(contextId: number, path: string): createTlvDemuxModule.ApplicationResource | null;
  isDeleted(): boolean;
  delete(): void;
}

export interface WorkerTlvDemuxModule {
  DurationProbe: new () => WorkerDurationProbe;
  TlvDemuxer: new (
    callbacks?: createTlvDemuxModule.TlvDemuxOptions,
    options?: WorkerDemuxerObjectOptions,
  ) => WorkerDemuxer;
  close(): void;
}

export declare function createWorkerTlvDemuxModule(options?: WorkerTlvDemuxModuleOptions): Promise<WorkerTlvDemuxModule>;
