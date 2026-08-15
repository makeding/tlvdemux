import assert from 'node:assert/strict';

import { HlgSdrRenderer } from '../hlg-sdr-renderer.mjs';

function fakeWebGl() {
  const calls = {draws: 0, clears: 0, lutUploads: 0, videoUploads: 0, comparison: []};
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
const size = 2;
renderer.setColorLut({
  size,
  width: size * size,
  height: size,
  data: new Uint8Array(size ** 3 * 4).fill(255),
});
renderer.setComparisonEnabled(true);
renderer.setEnabled(true);
await new Promise(resolve => setTimeout(resolve, 0));

assert.deepEqual(backends, ['WebGL']);
assert.equal(webGpuCanvas.hidden, true);
assert.equal(webGlCanvas.hidden, false);
assert.equal(calls.contextOptions.alpha, true);
assert.equal(calls.lutUploads, 1);
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

console.log('HLG-SDR renderer fallback test passed');
