import assert from 'node:assert/strict';
import {readdirSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = resolve(root, 'dist/tlvdemux.js');
const native = resolve(root, 'build/tlvdemux');
const videoToolbox = resolve(root, 'build/tlvdemux-videotoolbox-probe');
const hardwareOnly = process.argv.includes('--hardware-only');
const maxProbeBytes = 16 * 1024 * 1024;

const samples = [
  {path: 'demo/20260728-101-162500_6fc8390b-bf23-41c3-beb6-6301b012be26-superimpose-sample.mmts', size: 584150740, duration: '375.625221', subtitles: true},
  {path: 'demo/20260731-101-180000_9220c865-bfab-4d4d-8651-824b8e91a9e1.mmts', size: 5462022193, duration: '1636.179255'},
  {path: 'demo/20260731-102-170000_272b7cdc-8d85-4f77-91df-b935f3ae0e96.mmts', size: 5206465015, duration: '465.949621'},
  {path: 'demo/20260815-141-020000_34968268-7eab-4ee5-ab93-d2097c3d839f.mmts', size: 6685541501, duration: '1815.036727'},
  {path: 'demo/20260828-101-021500_8deb3dd2-39e9-471c-a9ba-a6dfe23feeb6.mmts', size: 1487535853, duration: '536.686256', audioDamage: true},
  {path: 'demo/20260828-141-020000_99332dc9-025e-4e76-afc4-e31c3d577059.mmts', size: 1792861104, duration: '496.913089', videoDamage: true},
  {path: 'demo/8k.mmts', size: 4360105984, duration: '459.572727', randomSeeks: true},
  {path: 'demo/8k1.mmts', size: 364994560, duration: '31.915216'},
  {path: 'demo/audiotrack.tlv', size: 173162496, duration: '60.744010', layers: true},
  {path: 'demo/bsp4k-lag-1.mmts', size: 162234368, duration: '41.739360'},
  {path: 'demo/bsp4k.mmts', size: 1356746752, duration: '451.934827'},
  {path: 'demo/rain-2.tlv', size: 434642944, duration: '151.328227'},
  {path: 'demo/rain.tlv', size: 745869312, duration: '414.697478', rain: true},
  {path: 'demo/test.tlv', size: 67211264, duration: '18.968938', subtitles: true},
  {path: 'test.tlv', size: 66142023, duration: '19.090088', subtitles: true},
];

function mediaFiles(directory) {
  return readdirSync(resolve(root, directory), {withFileTypes: true})
    .filter(entry => entry.isFile() && /\.(?:tlv|mmts|mmt)$/i.test(entry.name))
    .map(entry => directory === '.' ? entry.name : `${directory}/${entry.name}`);
}

const inventoried = samples.map(sample => sample.path).toSorted();
const present = [...mediaFiles('.'), ...mediaFiles('demo')].toSorted();
assert.deepEqual(present, inventoried,
  'sample inventory changed; every media file must be explicitly assigned a regression');
for (const sample of samples) {
  assert.equal(statSync(resolve(root, sample.path)).size, sample.size,
    `${sample.path} bytes changed; review and update its regression contract`);
}

function run(label, command, arguments_) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, arguments_, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label} exited ${result.status}`);
  if (command === videoToolbox) {
    const summaries = (result.stderr.match(
      /^(?:decoded=.*|cocktail cases=.*result=PASS)$/gm) ?? []);
    console.log(summaries.at(-1) ?? 'VideoToolbox PASS');
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}

function probe(sample) {
  const result = spawnSync(native, ['probe', sample.path], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.error, undefined, `${sample.path}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${sample.path}: duration probe failed`);
  const match = /^duration=([0-9.]+) bytes-read=([0-9]+)$/m.exec(result.stdout);
  assert.ok(match, `${sample.path}: duration probe output is incomplete`);
  assert.equal(match[1], sample.duration, `${sample.path}: physical duration changed`);
  assert.ok(Number(match[2]) <= maxProbeBytes,
    `${sample.path}: duration probe exceeded 16 MiB (${match[2]} bytes)`);
}

if (hardwareOnly) {
  for (const sample of samples) {
    const arguments_ = sample.rain
      ? [sample.path, '--mse', '--video-packet-id', '0xf300', '--audio-packet-id', '0xf310',
        '--fallback-video-packet-id', '0xf301', '--fallback-audio-packet-id', '0xf314',
        '--expect-rainfall-init', '--max-au', '30000', '--inflight', '8']
      : [sample.path, '--mse', '--max-au', '90', '--inflight', '4'];
    run(`VideoToolbox ${sample.path}`, videoToolbox, arguments_);
    if (sample.randomSeeks) {
      run(`VideoToolbox random seeks ${sample.path}`, videoToolbox,
        [sample.path, '--mse', '--rate', '3', '--inflight', '4', '--max-au', '90',
          '--random-seeks', '16', '--seed', '20260731']);
    }
  }
  console.log(`\nInventory hardware regression passed (${samples.length} samples)`);
  process.exit(0);
}

for (const sample of samples) {
  console.log(`\n=== bounded duration ${sample.path} ===`);
  probe(sample);
  if (sample.rain) {
    run(`bounded automatic startup ${sample.path}`, process.execPath,
      ['tests/wasm_startup_flow_control_sample.mjs', wasm, sample.path]);
  } else {
    run(`bounded WASM/MSE startup ${sample.path}`, process.execPath,
      ['tests/demo_playback_smoke.mjs', wasm, sample.path]);
  }
}

for (const sample of samples) {
  if (sample.rain) {
    run(`full automatic fallback ${sample.path}`, process.execPath,
      ['tests/wasm_layer_switch_full_sample.mjs', wasm, sample.path, sample.duration]);
  } else {
    run(`full WASM/index ${sample.path}`, process.execPath,
      ['tests/wasm_full_sample_regression.mjs', wasm, sample.path]);
  }
  if (sample.subtitles) {
    run(`subtitle metadata ${sample.path}`, process.execPath,
      ['tests/wasm_subtitle_metadata_sample.mjs', wasm, sample.path]);
  }
  if (sample.audioDamage) {
    run(`AAC damage flow ${sample.path}`, process.execPath,
      ['tests/wasm_audio_damage_flow_sample.mjs', wasm, sample.path]);
  }
  if (sample.videoDamage) {
    run(`single-layer video damage flow ${sample.path}`, process.execPath,
      ['tests/wasm_single_track_damage_flow_sample.mjs', wasm, sample.path]);
  }
}

run('rain recorded seeks 60/200/380s', process.execPath,
  ['tests/wasm_seek_smoke.mjs', wasm, 'demo/rain.tlv', '60', '200', '380']);
run('variable-rate recorded seek 452.985098s', process.execPath, [
  'tests/wasm_seek_smoke.mjs', wasm,
  'demo/20260731-101-180000_9220c865-bfab-4d4d-8651-824b8e91a9e1.mmts',
  '452.985098',
]);
run('variable-rate recorded seek grid', process.execPath, [
  'tests/wasm_seek_smoke.mjs', wasm,
  'demo/20260731-102-170000_272b7cdc-8d85-4f77-91df-b935f3ae0e96.mmts',
  '1', '60', '110.390227', '139.276545', '150.886703', '197.260826', '300', '450',
]);
run('manual rainfall to automatic preferred', process.execPath,
  ['tests/wasm_manual_auto_layer_sample.mjs', wasm, 'demo/audiotrack.tlv', 'restore']);
run('manual rainfall to automatic damaged preferred', process.execPath,
  ['tests/wasm_manual_auto_layer_sample.mjs', wasm, 'demo/rain.tlv', 'defer']);
run('coordinated layer switch', process.execPath,
  ['tests/wasm_layer_switch_sample.mjs', wasm, 'demo/audiotrack.tlv']);

console.log(`\nInventory software regression passed (${samples.length} samples)`);
