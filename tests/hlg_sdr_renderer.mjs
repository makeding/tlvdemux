import assert from 'node:assert/strict';

import { HlgSdrRenderer } from '../hlg-sdr-renderer.mjs';

function fakeWebGl() {
  const calls = {
    draws: 0, clears: 0, lutUploads: 0, videoUploads: 0,
    comparison: [], lutTextureSizes: [],
  };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE_2D: 8,
    TEXTURE_MIN_FILTER: 9,
    TEXTURE_MAG_FILTER: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    LINEAR: 13,
    CLAMP_TO_EDGE: 14,
    TEXTURE0: 15,
    TEXTURE1: 16,
    UNPACK_ALIGNMENT: 17,
    UNPACK_FLIP_Y_WEBGL: 18,
    RGBA: 19,
    UNSIGNED_BYTE: 20,
    TRIANGLES: 21,
    COLOR_BUFFER_BIT: 22,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram() {},
    useProgram() {},
    getAttribLocation: () => 0,
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    createTexture: () => ({}),
    bindTexture() {},
    texParameteri() {},
    getUniformLocation: (_program, name) => name,
    uniform1i() {},
    uniform1f(location, value) {
      if (location === 'uComparison') calls.comparison.push(value);
    },
    uniform2f(location, width, height) {
      if (location === 'uLutTextureSize') calls.lutTextureSizes.push([width, height]);
    },
    activeTexture() {},
    pixelStorei() {},
    texImage2D(...args) {
      if (args.length === 9) calls.lutUploads += 1;
      else calls.videoUploads += 1;
    },
    viewport() {},
    clearColor() {},
    clear() { calls.clears += 1; },
    drawArrays() { calls.draws += 1; },
    deleteTexture() {},
  };
  return {gl, calls};
}

const video = new EventTarget();
Object.assign(video, {
  readyState: 2,
  videoWidth: 1920,
  videoHeight: 1080,
  paused: true,
  ended: false,
});
const {gl, calls} = fakeWebGl();
const webGpuCanvas = {hidden: true};
const webGlCanvas = {
  hidden: true,
  clientWidth: 640,
  clientHeight: 360,
  width: 0,
  height: 0,
  getContext(kind, options) {
    calls.contextOptions = options;
    return kind === 'webgl' ? gl : null;
  },
};
const backends = [];
const renderer = new HlgSdrRenderer({
  video,
  webGpuCanvas,
  webGlCanvas,
  onBackendChange: backend => backends.push(backend),
});
const size = 128;
const width = 1536;
const height = 1408;
renderer.setColorLut({
  size,
  width,
  height,
  data: new Uint8Array(width * height * 4).fill(255),
});
renderer.setComparisonEnabled(true);
renderer.setEnabled(true);
await new Promise(resolve => setTimeout(resolve, 0));

assert.deepEqual(backends, ['WebGL']);
assert.equal(webGpuCanvas.hidden, true);
assert.equal(webGlCanvas.hidden, false);
assert.equal(calls.contextOptions.alpha, true);
assert.equal(calls.lutUploads, 1);
assert.deepEqual(calls.lutTextureSizes, [[1536, 1408]]);
assert.equal(calls.videoUploads, 1);
assert.equal(calls.draws, 1);
assert.equal(calls.clears, 1);
assert.deepEqual(calls.comparison, [1]);

renderer.setComparisonEnabled(false);
assert.equal(calls.draws, 2);
assert.equal(calls.clears, 2);
assert.deepEqual(calls.comparison, [1, 0]);

renderer.setEnabled(false);
assert.equal(webGlCanvas.hidden, true);
renderer.destroy();

const originalNavigator = globalThis.navigator;
const originalGpuBufferUsage = globalThis.GPUBufferUsage;
const originalGpuTextureUsage = globalThis.GPUTextureUsage;
const gpuCalls = {
  shader: '', textureDescriptors: [], writeTextures: [], textureViews: 0,
  samplerDescriptors: [], draws: 0,
};
const gpuContext = {
  configure() {},
  getCurrentTexture: () => ({createView: () => ({})}),
};
const gpuDevice = {
  lost: new Promise(() => {}),
  queue: {
    writeTexture(destination, data, layout, size3d) {
      gpuCalls.writeTextures.push({destination, data, layout, size: size3d});
    },
    writeBuffer() {},
    submit() {},
  },
  createShaderModule({code}) {
    gpuCalls.shader = code;
    return {};
  },
  createRenderPipeline: () => ({getBindGroupLayout: () => ({})}),
  createSampler(descriptor) {
    gpuCalls.samplerDescriptors.push(descriptor);
    return {};
  },
  createBuffer: () => ({destroy() {}}),
  createTexture(descriptor) {
    gpuCalls.textureDescriptors.push(descriptor);
    return {
      createView() {
        gpuCalls.textureViews += 1;
        return {};
      },
      destroy() {},
    };
  },
  importExternalTexture: () => ({}),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({
    beginRenderPass: () => ({
      setPipeline() {}, setBindGroup() {},
      draw() { gpuCalls.draws += 1; },
      end() {},
    }),
    finish: () => ({}),
  }),
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    gpu: {
      requestAdapter: async () => ({requestDevice: async () => gpuDevice}),
      getPreferredCanvasFormat: () => 'rgba8unorm',
    },
  },
});
globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2};
globalThis.GPUTextureUsage = {TEXTURE_BINDING: 1, COPY_DST: 2};

const gpuCanvas = {
  hidden: true,
  clientWidth: 640,
  clientHeight: 360,
  width: 0,
  height: 0,
  getContext: kind => kind === 'webgpu' ? gpuContext : null,
};
const unusedWebGlCanvas = {hidden: true};
const gpuBackends = [];
const gpuRenderer = new HlgSdrRenderer({
  video,
  webGpuCanvas: gpuCanvas,
  webGlCanvas: unusedWebGlCanvas,
  onBackendChange: backend => gpuBackends.push(backend),
});
const gpuLutSize = 3;
const gpuLutColumns = 2;
const gpuLutWidth = 6;
const gpuLutHeight = 6;
const gpuLutData = new Uint8Array(gpuLutWidth * gpuLutHeight * 4);
for (let blue = 0; blue < gpuLutSize; blue += 1) {
  for (let green = 0; green < gpuLutSize; green += 1) {
    for (let red = 0; red < gpuLutSize; red += 1) {
      const sourceX = (blue % gpuLutColumns) * gpuLutSize + red;
      const sourceY = Math.floor(blue / gpuLutColumns) * gpuLutSize + green;
      const source = (sourceY * gpuLutWidth + sourceX) * 4;
      gpuLutData.set([red, green, blue, 255], source);
    }
  }
}
gpuRenderer.setColorLut({
  size: gpuLutSize,
  width: gpuLutWidth,
  height: gpuLutHeight,
  data: gpuLutData,
});
gpuRenderer.setEnabled(true);
await new Promise(resolve => setTimeout(resolve, 0));

assert.deepEqual(gpuBackends, ['WebGPU']);
assert.match(gpuCalls.shader, /texture_3d<f32>/);
assert.doesNotMatch(gpuCalls.shader, /lowerBlue|upperBlue|lowerSlice|upperSlice/);
assert.deepEqual(gpuCalls.samplerDescriptors,
  [{magFilter: 'linear', minFilter: 'linear'}]);
assert.deepEqual(gpuCalls.textureDescriptors[0].size, [3, 3, 3]);
assert.equal(gpuCalls.textureDescriptors[0].dimension, '3d');
assert.equal(gpuCalls.writeTextures.length, 1);
assert.deepEqual(gpuCalls.writeTextures[0].size,
  {width: 3, height: 3, depthOrArrayLayers: 3});
assert.equal(gpuCalls.writeTextures[0].layout.bytesPerRow, 256);
assert.equal(gpuCalls.writeTextures[0].layout.rowsPerImage, 3);
for (let blue = 0; blue < gpuLutSize; blue += 1) {
  for (let green = 0; green < gpuLutSize; green += 1) {
    for (let red = 0; red < gpuLutSize; red += 1) {
      const offset = (blue * 3 + green) * 256 + red * 4;
      assert.deepEqual([...gpuCalls.writeTextures[0].data.subarray(offset, offset + 4)],
        [red, green, blue, 255]);
    }
  }
}
assert.equal(gpuCalls.draws, 1);
assert.equal(gpuCalls.textureViews, 1);
gpuRenderer.destroy();

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: originalNavigator,
});
globalThis.GPUBufferUsage = originalGpuBufferUsage;
globalThis.GPUTextureUsage = originalGpuTextureUsage;

console.log('HLG-SDR renderer tests passed');
