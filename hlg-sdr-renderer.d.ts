export interface HlgSdrRendererOptions {
  video: HTMLVideoElement;
  webGpuCanvas: HTMLCanvasElement;
  webGlCanvas: HTMLCanvasElement;
  onError?: (backend: "WebGPU" | "WebGL", error: unknown) => void;
  onBackendChange?: (backend: "WebGPU" | "WebGL") => void;
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
  destroy(): void;
}
