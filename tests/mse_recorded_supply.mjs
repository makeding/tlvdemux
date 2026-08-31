import assert from 'node:assert/strict';
import {runMseRecordedSupply} from '../mse-recorded-supply.mjs';

{
  const opened = [];
  const consumed = [];
  const progress = [];
  const source = {
    size: 9n,
    async *stream(offset, {signal}) {
      opened.push(offset);
      assert.equal(signal, null);
      yield Uint8Array.of(1, 2);
      yield Uint8Array.of(3, 4, 5);
    },
  };
  const result = await runMseRecordedSupply({
    source,
    startOffset: 4n,
    consume: fragment => consumed.push({offset: fragment.offset, data: [...fragment.data]}),
    onProgress: item => progress.push(item),
  });
  assert.deepEqual(opened, [4n]);
  assert.deepEqual(consumed, [
    {offset: 4n, data: [1, 2]},
    {offset: 6n, data: [3, 4, 5]},
  ]);
  assert.deepEqual(result, {nextOffset: 9n, bytesRead: 5n});
  assert.equal(progress.at(-1).nextOffset, 9n);
}

{
  const controller = new AbortController();
  let closed = false;
  const source = {
    size: null,
    async *stream() {
      try {
        yield Uint8Array.of(1);
        yield Uint8Array.of(2);
      } finally {
        closed = true;
      }
    },
  };
  await assert.rejects(runMseRecordedSupply({
    source,
    signal: controller.signal,
    consume() { controller.abort(); },
  }), error => error?.name === 'AbortError');
  assert.equal(closed, true, 'cancelling playback did not close the old sequential stream');
}

console.log('MSE recorded supply tests passed');
