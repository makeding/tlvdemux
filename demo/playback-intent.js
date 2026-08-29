function supersededError() {
  return new DOMException('Playback intent superseded.', 'AbortError');
}

export function createPlaybackIntentCoordinator({
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  let serial = 0;
  let current = null;
  let scheduled = null;
  let commitLane = Promise.resolve();

  const cancelScheduled = () => {
    if (scheduled === null) return;
    clearTimer(scheduled.handle);
    scheduled = null;
  };
  const begin = ({generation, demuxIdentity, kind, target = null}) => {
    cancelScheduled();
    current = Object.freeze({
      generation,
      serial: ++serial,
      demuxIdentity,
      kind,
      target,
    });
    return current;
  };
  const isCurrent = token => token !== null && token === current;
  const isCurrentDemux = demuxIdentity =>
    current !== null && current.demuxIdentity === demuxIdentity;
  const assertCurrent = token => {
    if (!isCurrent(token)) throw supersededError();
  };
  const schedule = (token, delay, operation) => {
    assertCurrent(token);
    cancelScheduled();
    const entry = {handle: null, token};
    entry.handle = setTimer(() => {
      if (scheduled !== entry) return;
      scheduled = null;
      if (!isCurrent(token)) return;
      void operation(token);
    }, delay);
    scheduled = entry;
  };
  const runCommit = (token, operation) => {
    const pending = commitLane.then(async () => {
      assertCurrent(token);
      const result = await operation(() => assertCurrent(token));
      assertCurrent(token);
      return result;
    });
    commitLane = pending.catch(() => {});
    return pending;
  };
  const invalidate = () => {
    cancelScheduled();
    current = null;
  };
  const complete = token => {
    if (!isCurrent(token)) return false;
    cancelScheduled();
    current = null;
    return true;
  };

  return {
    begin,
    current: () => current,
    isCurrent,
    isCurrentDemux,
    assertCurrent,
    schedule,
    runCommit,
    cancelScheduled,
    complete,
    invalidate,
  };
}
