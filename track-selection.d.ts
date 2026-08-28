export interface AssetGroup {
  groupIdentification: number;
  selectionLevel: number;
}
export interface PlaybackTrack {
  trackId: bigint | number;
  packetId: number;
  contextId?: number;
  componentTag: number;
  kind: string;
  assetGroups?: readonly AssetGroup[];
  subtitle?: {type: number; [name: string]: unknown};
  [name: string]: unknown;
}
export interface AudioSelectionIdentity {
  contextId?: number;
  componentTag: number;
  groupIdentification: number;
  selectionLevel: number;
}
export interface TrackChoice<T extends PlaybackTrack = PlaybackTrack> {
  track: T;
  groupIdentification: number | null;
}
export interface Layer<T extends PlaybackTrack = PlaybackTrack> {
  video: T;
  audio: T;
  groupIdentification: number;
}
export interface LayerPair<T extends PlaybackTrack = PlaybackTrack> {
  preferred: Layer<T>;
  fallback: Layer<T> | null;
}
export declare function selectionLevel(track: PlaybackTrack | null, groupIdentification?: number | null): number | null;
export declare function shouldReprobeVideoLayerForSeek(track: PlaybackTrack | null, explicitPacketId?: number): boolean;
export declare function automaticLayerSwitchEnabled(explicitPacketId?: number): boolean;
export declare function sameVideoLayerGroup(left: PlaybackTrack | null, right: PlaybackTrack | null): boolean;
export declare function correspondingAudioTrack<T extends PlaybackTrack>(
  tracks: Iterable<T>, currentTrack: T | null, targetLevel: number | null,
  activeGroupId?: number | null,
): TrackChoice<T> | null;
export declare function audioSelectionIdentity(
  track: PlaybackTrack | null, groupIdentification?: number | null,
): AudioSelectionIdentity | null;
export declare function resolveAudioSelection<T extends PlaybackTrack>(
  tracks: Iterable<T>, identity: AudioSelectionIdentity | null, targetLevel: number | null,
  supported?: (track: T) => boolean,
): TrackChoice<T> | null;
export declare function audioTrackChoices<T extends PlaybackTrack>(
  tracks: Iterable<T>, supported?: (track: T) => boolean,
): TrackChoice<T>[];
export declare function currentMptTracks<T extends PlaybackTrack>(
  snapshotTracks: Iterable<T>, selectableTracks: Iterable<T>,
): T[];
export declare function resolveLayerPair<T extends PlaybackTrack>(
  tracks: Iterable<T>, currentVideo: T, currentAudio: T, activeAudioGroupId?: number | null,
): LayerPair<T> | null;
export declare function configureAutomaticLayerPair(
  demuxer: {
    suspendAutomaticLayerSwitch(
      preferredVideoTrackId: bigint | number, preferredAudioTrackId: bigint | number,
      fallbackVideoTrackId: bigint | number, fallbackAudioTrackId: bigint | number,
    ): unknown | Promise<unknown>;
    clearAutomaticLayerSwitch(): unknown | Promise<unknown>;
    configureAutomaticLayerSwitch(
      preferredVideoTrackId: bigint | number, preferredAudioTrackId: bigint | number,
      fallbackVideoTrackId: bigint | number, fallbackAudioTrackId: bigint | number,
    ): unknown | Promise<unknown>;
  },
  pair: LayerPair | null,
  previousSignature: string | null,
  options?: {manual?: boolean; force?: boolean},
): Promise<string>;
export declare function subtitleTrackKind(track: PlaybackTrack): 'caption' | 'superimpose';
export declare function preferredCaptionTrack<T extends PlaybackTrack>(
  tracks: Iterable<T>, preferredPacketId?: number | null,
): T | undefined;
export declare function shouldRenderSubtitleTrack(
  track: PlaybackTrack, selectedCaptionTrackId: bigint | number | null,
): boolean;
