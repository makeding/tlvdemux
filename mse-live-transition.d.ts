import type {MseAppendQueueOptions} from './mse-append-queue';
import type {MsePlaybackModeValue} from './mse-playback';

export interface MseLiveTransitionCommit {
  mode: MsePlaybackModeValue;
  target: number;
  mediaSource: MediaSource;
  url: string;
  queues: Map<string, unknown>;
  flow: unknown;
  pipeline: unknown;
  probeMedia: HTMLVideoElement;
  presentedTime: number | null;
}

export interface MseLiveTransitionManager {
  observeInit(init: {
    type: 'video' | 'audio'; mime: string; data: Uint8Array; [name: string]: unknown;
  }): void;
  observeSegment(segment: {
    type: 'video' | 'audio'; data: Uint8Array;
    startTimeUs: bigint; endTimeUs: bigint; [name: string]: unknown;
  }): void;
  observeSplice(type: 'video' | 'audio', splice: {
    presentationTimeUs: bigint; timestampOffsetUs?: bigint; [name: string]: unknown;
  }): void;
  transition(mode: 'audio-only' | 'restoring-video', target: number): Promise<{
    presentedTime: number | null;
  }>;
  destroy(): void;
}

export declare function createLiveMseTransitionManager(options: {
  MediaSourceClass: typeof MediaSource;
  media: HTMLMediaElement;
  queueOptions?: MseAppendQueueOptions;
  isActive: () => boolean;
  openMediaSource: (
    MediaSourceClass: typeof MediaSource, media: HTMLMediaElement,
  ) => Promise<{mediaSource: MediaSource; url: string}>;
  commit: (candidate: MseLiveTransitionCommit) => unknown | Promise<unknown>;
  appendLog: (message: string) => void;
  createProbeMedia?: () => HTMLVideoElement;
  mountProbeMedia?: (media: HTMLVideoElement) => void;
  revokeObjectURL?: (url: string) => void;
  queueFactory?: (
    type: 'video' | 'audio', init: Record<string, unknown>, onUpdateEnd: () => void,
    options: MseAppendQueueOptions, mediaSource: MediaSource, media: HTMLMediaElement,
  ) => unknown;
}): MseLiveTransitionManager;
