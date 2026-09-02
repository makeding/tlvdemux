export interface HlgSdrRendererOptions {
  video: HTMLVideoElement;
  webGpuCanvas: HTMLCanvasElement;
  webGlCanvas: HTMLCanvasElement;
  onError?: (backend: "WebGPU" | "WebGL", error: unknown) => void;
  onBackendChange?: (backend: "WebGPU" | "WebGL") => void;
}

export interface HlgSdrRenderedFrame {
  source: HTMLCanvasElement;
  mediaTime: number;
}

export class HlgSdrRenderer {
  constructor(options: HlgSdrRendererOptions);
  setColorLut(lut: {
    size: number;
    width: number;
    height: number;
    data: Uint8Array;
  }): void;
  setComparisonEnabled(enabled: boolean): void;
  setEnabled(enabled: boolean): void;
  readonly activeCanvas: HTMLCanvasElement | null;
  readonly hasActivePresentation: boolean;
  onRenderedFrame(listener: (frame: HlgSdrRenderedFrame) => void): () => void;
  destroy(): void;
}
