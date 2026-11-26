import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createReviewHostLauncher } from '../apps/agent/src/review-host-launch.mjs';

function fixture(timeout) {
  const child = Object.assign(new EventEmitter(), { unref() {} });
  let id;
  const launcher = createReviewHostLauncher({
    timeout,
    start(_executable, [url]) {
      id = new URLSearchParams(new URL(url).hash.slice(1)).get('launch');
      return child;
    },
  });
  const opening = launcher.open(
    'EaWReview.exe',
    'http://127.0.0.1:12345',
    new URLSearchParams({ path: 'fixture.yml', readOnly: 'english' }),
  );
  return { child, id, launcher, opening };
}

test('delegating the English original waits for the window to load the file', async () => {
  const { child, id, launcher, opening } = fixture();
  let done = false;
  void opening.then(() => {
    done = true;
  });
  child.emit('exit', 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(launcher.report('unrelated launch', true), false);
  assert.equal(launcher.report(id, true), true);
  await opening;
  assert.equal(launcher.report(id, true), false);
});

test('an exit error, a failed page load and a missing acknowledgement all reject', async () => {
  const crashed = fixture();
  crashed.child.emit('exit', 4);
  await assert.rejects(crashed.opening, /Не удалось запустить/u);

  const failed = fixture();
  assert.equal(failed.launcher.report(failed.id, false), true);
  await assert.rejects(failed.opening, /не загрузился/u);

  const timedOut = fixture(10);
  await assert.rejects(timedOut.opening, /не подтвердил/u);
  assert.equal(timedOut.launcher.report(timedOut.id, true), false);
});
