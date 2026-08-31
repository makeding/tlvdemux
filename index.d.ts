export as namespace createTlvDemuxModule;

declare function createTlvDemuxModule(
  moduleOverrides?: createTlvDemuxModule.TlvDemuxModuleOverrides,
): Promise<createTlvDemuxModule.TlvDemuxModule>;

declare namespace createTlvDemuxModule {
  type TrackKind = "video" | "audio" | "subtitle";
  type Codec = "hevc" | "aac-latm" | "ttml";
  type MseToneMappingMode = "auto" | "force" | "on_compare" | "prototype" | "off";

  interface HlgSdrColorLut {
    /** Number of samples on each RGB axis. */
    size: number;
    /** Packed texture width: size * size blue slices. */
    width: number;
    /** Packed texture height: size green samples. */
    height: number;
    /** Row-major RGBA8 texture data. */
    data: Uint8Array;
  }
  type ErrorCode =
    | "malformed-input"
    | "unsupported-feature"
    | "discontinuity"
    | "resource-limit";
  type IndexState =
    | "absent"
    | "loading"
    | "building"
    | "partial"
    | "following"
    | "complete"
    | "stale"
    | "failed";
  type DurationProbeState =
    | "idle"
    | "need-range"
    | "complete"
    | "unknown"
    | "failed"
    | "cancelled";
  type DurationProbeFailure =
    | "none"
    | "invalid-source"
    | "invalid-response"
    | "source-error"
    | "no-video"
    | "no-tail-timestamp"
    | "range-limit"
    | "parse-error";
  type ApplicationCollectionState = "discovered" | "collecting" | "ready";
  type ApplicationLifecycleState =
    | "unsupported"
    | "autostart-pending"
    | "autostart-ready"
    | "present"
    | "prefetching"
    | "prefetched"
    | "killed";

  interface TlvDemuxModuleOverrides {
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    onAbort?: (reason: unknown) => void;
    [name: string]: unknown;
  }

  interface Deletable {
    delete(): void;
    isDeleted(): boolean;
  }

  interface DurationInfo {
    value: bigint;
    timescale: number;
    status: "provisional" | "complete";
  }

  interface PresentationTimestamp {
    value: bigint;
    timescale: number;
  }

  interface SeekPoint {
    presentationTimeUs: bigint;
    signallingOffset: bigint;
    randomAccessOffset: bigint;
    videoTrackId: bigint;
    bootstrapId: bigint;
  }

  interface SeekPointPair {
    first: SeekPoint;
    second: SeekPoint | null;
  }

  interface BroadcastClock {
    mediaTimeValue: bigint;
    mediaTimeTimescale: number;
    broadcastTimeValue: bigint;
    broadcastTimeTimescale: number;
    inputOffset: bigint;
    discontinuity: boolean;
  }

  interface IpDataFlow {
    contextId: number;
    sequenceNumber: number;
    ipVersion: 6;
    sourceAddress: Uint8Array;
    destinationAddress: Uint8Array;
    nextHeader: number;
    sourcePort: number;
    destinationPort: number;
    inputOffset: bigint;
  }

  interface TransportNtpClock {
    ipVersion: 6;
    sourceAddress: Uint8Array;
    destinationAddress: Uint8Array;
    sourcePort: number;
    destinationPort: number;
    leapIndicator: number;
    version: number;
    mode: number;
    stratum: number;
    poll: number;
    precision: number;
    rootDelay: number;
    rootDispersion: number;
    referenceIdentification: number;
    referenceTimestamp: bigint;
    originTimestamp: bigint;
    receiveTimestamp: bigint;
    transmitTimestamp: bigint;
    transmitTimeValue: bigint;
    transmitTimeTimescale: number;
    inputOffset: bigint;
  }

  interface TlvDescriptor {
    tag: number;
    payload: Uint8Array;
    sectionOffset: number;
  }

  interface TlvNetworkStream {
    tlvStreamId: number;
    originalNetworkId: number;
    descriptors: TlvDescriptor[];
  }

  interface TlvNetworkInformation {
    tableId: 0x40 | 0x41;
    networkId: number;
    version: number;
    currentNext: boolean;
    lastSectionNumber: number;
    networkDescriptors: TlvDescriptor[];
    streams: TlvNetworkStream[];
    inputOffset: bigint;
  }

  interface AddressMapService {
    serviceId: number;
    ipVersion: 4 | 6;
    sourceAddress: Uint8Array;
    sourcePrefixLength: number;
    destinationAddress: Uint8Array;
    destinationPrefixLength: number;
    privateData: Uint8Array;
  }

  interface AddressMap {
    tableId: 0xfe;
    tableIdExtension: 0;
    version: number;
    currentNext: boolean;
    lastSectionNumber: number;
    services: AddressMapService[];
    inputOffset: bigint;
  }

  interface RawSignallingTable {
    tlvPacketType: 0xfe;
    tableId: number;
    tableIdExtension: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    data: Uint8Array;
    inputOffset: bigint;
  }

  interface UnknownDescriptor {
    tableId: number;
    tag: number;
    scope: "network" | "tlv-stream";
    tlvStreamId: number | null;
    originalNetworkId: number | null;
    sectionOffset: number;
    payload: Uint8Array;
    inputOffset: bigint;
  }

  interface SignallingMessage {
    contextId: number;
    packetId: number;
    messageId: number;
    data: Uint8Array;
    inputOffset: bigint;
  }

  interface ServiceInfo {
    contextId: number;
    packageId: Uint8Array;
  }

  interface MpuPresentationRegion {
    mpuSequenceNumber: number;
    layoutNumber: number;
    regionNumber: number;
  }

  interface LayoutRegion {
    regionNumber: number;
    leftTopPosX: number;
    leftTopPosY: number;
    rightDownPosX: number;
    rightDownPosY: number;
    layerOrder: number;
  }

  interface LayoutDevice {
    layoutNumber: number;
    deviceId: number;
    regions: LayoutRegion[];
  }

  interface LayoutConfiguration {
    contextId: number;
    sourcePacketId: number;
    version: number;
    devices: LayoutDevice[];
    /** ARIB STD-B60 RGB value encoded as 0xRRGGBB, or null when absent. */
    backgroundColorRgb: number | null;
    inputOffset: bigint;
  }

  interface AudioTrackInfo {
    componentType: number;
    componentTag: number;
    channelLayout: number;
    /** Actual speaker-channel count; zero when the signalled layout is unknown. */
    channels: number;
    streamType: number;
    simulcastGroupTag: number;
    multilingual: boolean;
    sampleRate: number;
    mainComponent: boolean;
    secondaryLanguage: string;
  }

  interface SubtitleTrackInfo {
    /** ARIB STD-B60 subtitle_tag. */
    tag: number;
    infoVersion: number;
    /** 0 is caption and 1 is character superimpose. */
    type: 0 | 1;
    format: number;
    operationMode: number;
    timingMode: number;
    displayMode: number;
    resolution: number;
    compressionType: number;
    startMpuSequenceNumber: number | null;
    /** Unsigned 64-bit NTP reference_start_time, or null when absent. */
    referenceStartNtp: bigint | null;
    referenceStartTimeLeapIndicator: number;
  }

  interface AssetGroupInfo {
    groupIdentification: number;
    selectionLevel: number;
  }

  interface VideoTrackInfo {
    /** ARIB STD-B60 programme descriptor value, or null when absent. */
    hdrWcgIdc: number | null;
    /** ARIB STD-B60 programme transfer-characteristics value, or null when absent. */
    videoTransferCharacteristics: number | null;
  }

  interface TrackInfo {
    trackId: bigint;
    contextId: number;
    packetId: number;
    kind: TrackKind;
    codec: Codec;
    language: string;
    componentTag: number;
    timescale: number;
    /** ARIB STD-B60 Asset Group descriptors; an asset may belong to multiple groups. */
    assetGroups: AssetGroupInfo[];
    presentationRegions: MpuPresentationRegion[];
    video?: VideoTrackInfo;
    audio?: AudioTrackInfo;
    subtitle?: SubtitleTrackInfo;
  }

  interface ApplicationServiceInfo {
    contextId: number;
    applicationFormat: number;
    documentResolution: number;
    defaultAit: boolean;
    hasDataTransmissionMessages: boolean;
    aitPacketId: number | null;
    dataTransmissionPacketId: number | null;
  }

  interface DataAssetInfo {
    contextId: number;
    packetId: number;
    assetType: string;
    componentTag: number;
    presentationRegions: MpuPresentationRegion[];
  }

  interface ApplicationInfo {
    contextId: number;
    sourcePacketId: number;
    applicationType: number;
    organizationId: number;
    applicationId: number;
    controlCode: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    presentApplicationPriority: boolean;
    applicationPriority: number;
    entryPath: string;
    inputOffset: bigint;
  }

  interface MptSnapshot {
    contextId: number;
    sourcePacketId: number;
    packageId: Uint8Array;
    version: number;
    mode: number;
    inputOffset: bigint;
    tracks: TrackInfo[];
    applicationServices: ApplicationServiceInfo[];
    dataAssets: DataAssetInfo[];
  }

  interface MhAitSnapshot {
    contextId: number;
    sourcePacketId: number;
    applicationType: number;
    version: number;
    currentNext: boolean;
    inputOffset: bigint;
    applications: ApplicationInfo[];
  }

  interface ServiceStateReset {
    contextId: number | null;
    reason: "full-reset" | "service-selection";
  }

  interface SubtitleResource {
    subsampleNumber: number;
    dataType: number;
    data: Uint8Array;
  }

  interface AccessUnit {
    trackId: bigint;
    codec: Codec;
    componentTag: number;
    subtitleTimingMode: number | null;
    subtitleOperationMode: number | null;
    subtitleDisplayMode: number | null;
    subtitleCompressionType: number | null;
    data: Uint8Array;
    ptsValue: bigint;
    ptsTimescale: number;
    dtsValue: bigint;
    dtsTimescale: number;
    mpuSequenceNumber: number | null;
    subtitleReferenceStartPtsValue: bigint | null;
    subtitleReferenceStartPtsTimescale: number | null;
    subtitleResources: SubtitleResource[];
    restartOffset: bigint;
    inputOffset: bigint;
    randomAccess: boolean;
    discontinuity: boolean;
    /** Bitmask of libaribtlv discontinuity reasons. */
    discontinuityReasons: number;
    dataLifetime?: "callback";
  }

  interface DamageSpan {
    trackId: bigint;
    kind: TrackKind;
    codec: Codec;
    startPtsValue: bigint | null;
    startPtsTimescale: number | null;
    endPtsValue: bigint;
    endPtsTimescale: number;
    recoveryPtsValue: bigint | null;
    recoveryPtsTimescale: number | null;
    startInputOffset: bigint;
    endInputOffset: bigint;
    recoveryInputOffset: bigint;
    recoveryRestartOffset: bigint;
    /** Bitmask of libaribtlv discontinuity reasons. */
    reasons: number;
    recovered: boolean;
    recoveryRandomAccess: boolean;
  }

  interface DemuxError {
    code: ErrorCode;
    inputOffset: bigint;
    recoverable: boolean;
    message: string;
  }

  interface EventInfo {
    contextId: number;
    sourcePacketId: number;
    tableId: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    serviceId: number;
    tlvStreamId: number;
    originalNetworkId: number;
    eventId: number;
    startTimeUnixMilliseconds: number | null;
    durationSeconds: number | null;
    runningStatus: number;
    freeCaMode: boolean;
    language: string;
    title: string;
    /** Structured ARIB HDR icon from the MH-EIT short-event title field. */
    hdrProgrammeIcon: boolean;
    /** Positive HDR programme marker from MH-EIT; unknown is not SDR. */
    videoPresentationHint: "hdr" | "unknown";
    description: string;
    extendedDescription: string;
    extendedItems: Array<{ description: string; value: string }>;
    genres: Array<{ level1: number; level2: number; user1: number; user2: number }>;
    parentalRatings: Array<{ countryCode: string; rating: number }>;
    audioComponents: Array<{
      componentType: number;
      componentTag: number;
      channelLayout: number;
      channels: number;
      streamType: number;
      multilingual: boolean;
      mainComponent: boolean;
      sampleRate: number;
      language: string;
      secondaryLanguage: string;
      text: string;
    }>;
    series: {
      seriesId: number;
      repeatLabel: number;
      programPattern: number;
      expireDateMjd: number | null;
      episodeNumber: number;
      lastEpisodeNumber: number;
      name: string;
    } | null;
    inputOffset: bigint;
  }

  interface ServiceDescriptionInfo {
    serviceId: number;
    eitUserDefinedFlags: number;
    eitSchedule: boolean;
    eitPresentFollowing: boolean;
    runningStatus: number;
    freeCaMode: boolean;
    serviceType: number;
    providerName: string;
    serviceName: string;
  }

  interface MhSdtSnapshot {
    contextId: number;
    sourcePacketId: number;
    tableId: number;
    tlvStreamId: number;
    originalNetworkId: number;
    version: number;
    currentNext: boolean;
    services: ServiceDescriptionInfo[];
    inputOffset: bigint;
  }

  interface LocalTimeOffsetInfo {
    countryCode: string;
    countryRegionId: number;
    polarity: boolean;
    offsetMinutes: number;
    changeTimeUnixMilliseconds: number | null;
    nextOffsetMinutes: number;
  }

  interface MhTotInfo {
    contextId: number;
    sourcePacketId: number;
    timeUnixMilliseconds: number;
    localTimeOffsets: LocalTimeOffsetInfo[];
    inputOffset: bigint;
  }

  interface StreamEvent {
    contextId: number;
    sourcePacketId: number;
    eventMessageTag: number;
    dataEventId: number;
    messageGroupId: number;
    messageVersion: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    timeMode: number;
    timeValue: bigint;
    utcReference: bigint | null;
    nptReference: bigint | null;
    messageType: number;
    /** Raw 16-bit ARIB STD-B60 event_msg_id, retained for diagnostics. */
    rawMessageId: number;
    /** High octet exposed as message_id to ARIB STD-B62 applications. */
    messageId: number;
    privateData: Uint8Array;
    inputOffset: bigint;
  }

  /**
   * Receiver-level TR-B39 viewer-participation corner notification. This is
   * intentionally separate from StreamEvent because it is not dispatched to
   * the ARIB-HTML5 application as an interrupt event.
   */
  interface ViewerParticipationNotification {
    contextId: number;
    sourcePacketId: number;
    eventMessageTag: number;
    dataEventId: number;
    messageGroupId: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    inputOffset: bigint;
  }

  interface ApplicationState {
    contextId: number;
    sourcePacketId: number;
    applicationType: number;
    organizationId: number;
    applicationId: number;
    controlCode: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    inputOffset: bigint;
    applicationDescriptorPresent: boolean;
    profiles: Array<{
      applicationProfile: number;
      versionMajor: number;
      versionMinor: number;
      versionMicro: number;
    }>;
    serviceBound: boolean;
    /** MH-application descriptor visibility: 0/1 hidden from users, 3 visible. */
    visibility: number;
    presentApplicationPriority: boolean;
    applicationPriority: number;
    transportProtocolLabels: number[];
    transports: Array<{ protocolId: number; label: number; urls: string[] }>;
    entryPath: string;
    transportUrls: string[];
    state: ApplicationCollectionState;
    /** Broadcast-requested lifecycle; this does not claim the HTML runtime started. */
    lifecycle: ApplicationLifecycleState;
    entryReady: boolean;
    resourceCount: number;
  }

  interface ApplicationResourceMetadata {
    contextId: number;
    componentTag: number;
    transactionId: number;
    downloadId: number;
    mpuSequenceNumber: number;
    itemId: number;
    version: number;
    path: string;
    contentType: string;
    size: number;
    generation: bigint;
  }

  interface ApplicationResource
    extends Omit<ApplicationResourceMetadata, "size" | "generation"> {
    data: Uint8Array;
    dataLifetime?: "callback";
  }

  interface ApplicationResourceRemoval {
    contextId: number;
    componentTag: number;
    transactionId: number;
    downloadId: number;
    mpuSequenceNumber: number;
    itemId: number;
    path: string;
  }

  interface MseTrackInit {
    type: "video" | "audio";
    mime: string;
    data: Uint8Array;
    width: number;
    height: number;
    sampleRate: number;
    channels: number;
  }

  interface MseMediaSegment {
    type: "video" | "audio";
    data: Uint8Array;
    startTimeUs: bigint;
    endTimeUs: bigint;
  }

  interface MseAudioSplice {
    presentationTimeUs: bigint;
    /** Complete SourceBuffer.timestampOffset in microseconds, not a delta. */
    timestampOffsetUs: bigint;
  }

  interface MseVideoSplice {
    presentationTimeUs: bigint;
    /** Complete SourceBuffer.timestampOffset in microseconds, not a delta. */
    timestampOffsetUs: bigint;
  }

  interface MseLayerSwitch {
    videoTrackId: bigint;
    audioTrackId: bigint;
    videoPresentationTimeUs: bigint;
    audioPresentationTimeUs: bigint;
  }

  interface MseLayerSwitchStarted {
    videoTrackId: bigint;
    audioTrackId: bigint;
    previousVideoTrackId: bigint;
    previousAudioTrackId: bigint;
    earliestPresentationTimeUs: bigint;
    reason: "manual" | "health-degradation" | "source-damage";
  }

  interface MseLayerSwitchCancelled {
    videoTrackId: bigint;
    audioTrackId: bigint;
    previousVideoTrackId: bigint;
    previousAudioTrackId: bigint;
    reason: "end-of-input" | "reset" | "reposition" | "selection-changed";
  }

  interface MseVideoStart {
    nalType: number;
    signalledRandomAccess: boolean;
  }

  interface MseVideoRecoveryEvent {
    videoTrackId: bigint;
    presentationTimeUs: bigint;
    phase: "observation-started" | "candidate-rejected" | "stable-rap-committed";
  }

  interface MseVideoColor {
    primaries: number;
    transfer: number;
    matrix: number;
    fullRange: boolean;
  }

  interface MseHdrStaticMetadata {
    displayPrimariesX: [number, number, number];
    displayPrimariesY: [number, number, number];
    whitePointX: number;
    whitePointY: number;
    maxDisplayMasteringLuminance: number;
    minDisplayMasteringLuminance: number;
    maxContentLightLevel: number;
    maxPicAverageLightLevel: number;
    hasMasteringDisplay: boolean;
    hasContentLight: boolean;
  }

  interface MseVideoSignalling {
    hdrWcgIdc: number | null;
    videoTransferCharacteristics: number | null;
  }

  interface MseOutputCapabilities {
    edidValid: boolean;
    hdrSupport: boolean;
    pqEotf: boolean;
    hlgEotf: boolean;
    bt2020: boolean;
    supports4k50_60: boolean;
    colorSpaceMask: number;
    maxDeepColorBits: number;
    maxTmdsClockMhz: number;
  }

  interface MseOutputState {
    generation: bigint;
    connected: boolean;
    hdrMode: number;
    edidValid: boolean;
    hdrSupport: boolean;
    pqEotf: boolean;
    hlgEotf: boolean;
    bt2020: boolean;
    supports4k50_60: boolean;
    colorSpaceMask: number;
    maxDeepColorBits: number;
    maxTmdsClockMhz: number;
    dolbyTunnelSupported: boolean;
    dolbyMetadataPassthrough: boolean;
    dolbyObservedProfile: number | null;
  }

  interface MseVideoProperties {
    trackId: bigint;
    presentationTimeUs: bigint;
    width: number;
    height: number;
    codec: string;
    sourceColor: MseVideoColor | null;
    outputColor: MseVideoColor | null;
    hdrStaticMetadata: MseHdrStaticMetadata | null;
    sourceSignalling: MseVideoSignalling | null;
    sourceSignallingMismatch: boolean;
    sdrInHlg: boolean;
    hlgSdrPrototype: boolean;
  }

  interface PlaybackDamage {
    code: "TLV_SOURCE_DAMAGE";
    videoTrackId: bigint;
    startTimeUs: bigint | null;
    endTimeUs: bigint;
    recoveryTimeUs: bigint | null;
    startInputOffset: bigint;
    endInputOffset: bigint;
    recoveryInputOffset: bigint;
    recoveryRestartOffset: bigint;
    severity: "warning" | "severe";
    action: "none" | "seek-if-stalled" | "seek" | "wait-for-recovery";
  }

  interface TlvDemuxCallbacks {
    onService?: (service: ServiceInfo) => void;
    onIpDataFlow?: (flow: IpDataFlow) => void;
    onTransportNtpClock?: (clock: TransportNtpClock) => void;
    onTlvNetworkInformation?: (information: TlvNetworkInformation) => void;
    onAddressMap?: (map: AddressMap) => void;
    onRawSignallingTable?: (table: RawSignallingTable) => void;
    onUnknownDescriptor?: (descriptor: UnknownDescriptor) => void;
    onSignallingMessage?: (message: SignallingMessage) => void;
    onTrack?: (track: TrackInfo) => void;
    onTrackRemoved?: (track: TrackInfo) => void;
    onApplicationServiceRemoved?: (service: ApplicationServiceInfo) => void;
    onDataAssetRemoved?: (asset: DataAssetInfo) => void;
    onApplicationRemoved?: (application: ApplicationInfo) => void;
    onMptSnapshot?: (snapshot: MptSnapshot) => void;
    onMhAitSnapshot?: (snapshot: MhAitSnapshot) => void;
    onServiceStateReset?: (reset: ServiceStateReset) => void;
    onLayoutConfiguration?: (layout: LayoutConfiguration) => void;
    onAccessUnit?: (unit: AccessUnit) => void;
    onAccessUnitView?: (unit: AccessUnit) => void;
    /**
     * Callback-lifetime TTML payloads plus payload-free HEVC RAP/discontinuity
     * and AAC discontinuity events, intended for browser playback control.
     */
    onPlaybackAccessUnitView?: (unit: AccessUnit) => void;
    onError?: (error: DemuxError) => void;
    /** Raw source damage, before selected-track playback policy is applied. */
    onDamage?: (damage: DamageSpan) => void;
    onBroadcastClock?: (clock: BroadcastClock) => void;
    onEventInfo?: (event: EventInfo) => void;
    onMhSdtSnapshot?: (snapshot: MhSdtSnapshot) => void;
    onMhTot?: (info: MhTotInfo) => void;
    onStreamEvent?: (event: StreamEvent) => void;
    onViewerParticipationNotification?: (
      notification: ViewerParticipationNotification,
    ) => void;
    onApplicationState?: (application: ApplicationState) => void;
    onApplicationResource?: (resource: ApplicationResource) => void;
    onApplicationResourceView?: (resource: ApplicationResource) => void;
    onApplicationResourceRemoved?: (removal: ApplicationResourceRemoval) => void;
    onApplicationResourcesReset?: () => void;
    onMseInit?: (init: MseTrackInit) => void;
    onMseSegment?: (segment: MseMediaSegment) => void;
    onMseAudioSplice?: (splice: MseAudioSplice) => void;
    onMseVideoSplice?: (splice: MseVideoSplice) => void;
    onMseLayerSwitchStarted?: (started: MseLayerSwitchStarted) => void;
    onMseLayerSwitch?: (layer: MseLayerSwitch) => void;
    onMseLayerSwitchCancelled?: (cancelled: MseLayerSwitchCancelled) => void;
    onMseVideoStart?: (start: MseVideoStart) => void;
    onMseVideoRecovery?: (event: MseVideoRecoveryEvent) => void;
    /** HEVC VUI/output colour state, pushed at each parameter-set/RAP boundary. */
    onMseVideoProperties?: (properties: MseVideoProperties) => void;
    /** Output capability and connection state after EDID/mode changes. */
    onMseOutputState?: (state: MseOutputState) => void;
    /** Selected-video recovery advice with a stable user-facing error code. */
    onPlaybackDamage?: (damage: PlaybackDamage) => void;
  }

  interface TlvDemuxOptions extends TlvDemuxCallbacks {
    /** Suppress MSE AAC output above this channel count. Zero or omitted is unlimited. */
    mseMaxAudioChannels?: number;
  }

  /** Evidence published by the completed recorded-seek landing. */
  interface MseRecordedSeekLandingEvidence {
    landingMode: "exact" | "held-frame";
    /** The prior decodable video frame retained at the requested media clock. */
    heldFrameTimeUs: bigint | null;
    /** The first forward presentation time at which normal video resumes. */
    recoveryTimeUs: bigint | null;
  }

  interface TlvDemuxer extends Deletable {
    push(bytes: ArrayBufferView): boolean;
    pushFromHeap(address: number, size: number): boolean;
    flush(): void;
    reset(): void;
    reposition(inputOffset: bigint, preserveTimeline: boolean): void;
    selectService(contextId?: number | null): void;
    selectTrack(kind: TrackKind, trackId?: bigint | null): void;
    configureAutomaticLayerSwitch(
      preferredVideoTrackId: bigint,
      preferredAudioTrackId: bigint,
      fallbackVideoTrackId: bigint,
      fallbackAudioTrackId: bigint,
    ): void;
    suspendAutomaticLayerSwitch(
      preferredVideoTrackId: bigint,
      preferredAudioTrackId: bigint,
      fallbackVideoTrackId: bigint,
      fallbackAudioTrackId: bigint,
    ): void;
    clearAutomaticLayerSwitch(): void;
    setMseTimestampOffset(timestampOffsetUs: bigint): void;
    setMseRecordedSeekConcealmentTarget(presentationTimeUs?: bigint | null): void;
    getMseRecordedSeekLandingEvidence(): MseRecordedSeekLandingEvidence;
    beginMseRecordedSeek(): void;
    flushMseRecordedSeekLanding(): void;
    finishMseRecordedSeek(playbackPositionUs: bigint): void;
    cancelMseRecordedSeek(): void;
    /** Report the unchanged media clock for automatic layer recovery decisions. */
    setMsePlaybackPosition(presentationTimeUs: bigint): void;
    switchAudioTrack(trackId: bigint, earliestPresentationTimeUs: bigint): bigint | null;
    switchLayer(
      videoTrackId: bigint,
      audioTrackId: bigint,
      earliestPresentationTimeUs: bigint,
    ): boolean;
    switchLayerAtPlaybackEntry(
      videoTrackId: bigint,
      audioTrackId: bigint,
      playbackEntryTimeUs: bigint,
    ): boolean;
    setMseOutputEnabled(enabled: boolean): void;
    setSubtitlePassthroughEnabled(enabled: boolean): void;
    /** Reinterpret an explicitly identified SDR-in-HLG video track as UHD SDR. */
    setMseSdrInHlg(videoTrackId: bigint, enabled: boolean): void;
    /** Select automatic, forced, split comparison, or disabled HLG-SDR rendering. */
    setMseToneMappingMode(mode: MseToneMappingMode): void;
    /** Declare whether the MSE output path can present HLG directly. */
    setMseHlgOutputSupported(enabled: boolean): void;
    /** Supply an EDID block; capability parsing stops at standard CTA fields. */
    setMseEdid(edid: ArrayBufferView): void;
    /** Notify the output path about HDMI disconnect/reconnect. */
    setMseOutputConnected(connected: boolean): void;
    /** Monotonic generation incremented by output capability transitions. */
    mseOutputGeneration(): bigint;
    /** @deprecated Use hlgSdrColorLut so colour processing stays in C++. */
    hlgSdrToneMappingLut(): Uint8Array;
    /** Return the canonical C++ HLG-SDR packed RGB 3D LUT. */
    hlgSdrColorLut(): HlgSdrColorLut;
    /** Return the experimental controlled HLG-to-SDR packed RGB 3D LUT. */
    hlgSdrPrototypeColorLut(): HlgSdrColorLut;
    drainApplicationResources(maxEvents: number): boolean;
    startIndex(growing: boolean): void;
    finalizeIndex(): boolean;
    indexState(): IndexState;
    indexDuration(): DurationInfo | null;
    setIndexDuration(durationUs: bigint): boolean;
    seekPointCount(): number;
    indexedVideoTrack(): bigint | null;
    previousSync(targetUs: bigint): SeekPoint | null;
    seekPointsFor(targetUs: bigint): SeekPointPair | null;
    estimateOffset(targetUs: bigint, sourceSize: bigint): bigint | null;
    applicationResources(contextId?: number | null): ApplicationResourceMetadata[];
    applicationResource(contextId: number, path: string): ApplicationResource | null;
    applicationEntry(contextId: number): string | null;
    applications(): ApplicationState[];
    applicationResourceGeneration(): bigint;
    broadcastClock(): BroadcastClock | null;
  }

  interface DurationProbeOptions {
    initialRangeSize?: bigint;
    maxRangeSize?: bigint;
    serviceContextId?: number;
    videoPacketId?: number;
  }

  interface RangeRequest {
    generation: bigint;
    requestId: bigint;
    offset: bigint;
    length: bigint;
  }

  interface DurationProbe extends Deletable {
    begin(sourceSize: bigint, options?: DurationProbeOptions): boolean;
    nextRange(): RangeRequest | null;
    pushRange(
      requestId: bigint,
      absoluteOffset: bigint,
      bytes: ArrayBufferView,
      endOfRange: boolean,
    ): boolean;
    pushRangeFromHeap(
      requestId: bigint,
      absoluteOffset: bigint,
      address: number,
      size: number,
      endOfRange: boolean,
    ): boolean;
    failRange(requestId: bigint): boolean;
    cancel(): void;
    state(): DurationProbeState;
    failure(): DurationProbeFailure;
    duration(): DurationInfo | null;
    presentationStart(): PresentationTimestamp | null;
    presentationEnd(): PresentationTimestamp | null;
    selectedVideoPacketId(): number | null;
    presentationEndVideoPacketId(): number | null;
    generation(): bigint;
    transferredBytes(): bigint;
  }

  interface TlvDemuxModule {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(address: number): void;
    TlvDemuxer: new (options: TlvDemuxOptions) => TlvDemuxer;
    DurationProbe: new () => DurationProbe;
  }
}

export = createTlvDemuxModule;
