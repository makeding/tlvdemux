import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

globalThis.TlvDemuxWorkerProtocol = {};
const source = await readFile(new URL('../demo/worker-tlvdemux.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const {workerResultValue} = await import(moduleUrl);

assert.equal(workerResultValue({value: null}), null);
assert.equal(workerResultValue({value: false}), false);
assert.equal(workerResultValue({value: 0}), 0);
assert.equal(workerResultValue({value: undefined}), undefined);
assert.equal(workerResultValue({}), true);

console.log('worker result value tests passed');
