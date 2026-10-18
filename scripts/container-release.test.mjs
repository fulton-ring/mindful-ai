import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseMetadata } from './container-release.mjs';

const input = {
  eventName: 'workflow_dispatch',
  event: { inputs: { version: 'v1.2.3', publish: 'false' } },
  ref: 'refs/heads/feature',
  sha: 'a'.repeat(40),
  repository: 'Fulton-Ring/Mindful-AI',
};

test('dry runs can test a feature commit without publishing', () => {
  const metadata = releaseMetadata(input);
  assert.equal(metadata.publish, false);
  assert.equal(metadata.image, 'ghcr.io/fulton-ring/mindful-ai');
  assert.equal(metadata.version, 'v1.2.3');
  assert.equal(metadata.revision, input.sha);
});

test('manual publication requires the main branch', () => {
  const event = { inputs: { version: 'v1.2.3', publish: 'true' } };
  assert.throws(() => releaseMetadata({ ...input, event }), /main/);
  assert.equal(releaseMetadata({ ...input, event, ref: 'refs/heads/main' }).publish, true);
});

test('published releases must use their immutable version tag', () => {
  const event = { release: { tag_name: 'v1.2.3-rc.1', prerelease: true } };
  const release = { ...input, eventName: 'release', event, ref: 'refs/tags/v1.2.3-rc.1' };
  assert.equal(releaseMetadata(release).latest, false);
  assert.equal(releaseMetadata(release).publish, true);
  assert.throws(() => releaseMetadata({ ...release, ref: 'refs/tags/v1.2.3' }), /tag/);
  assert.throws(
    () =>
      releaseMetadata({ ...release, event: { release: { ...event.release, prerelease: false } } }),
    /prerelease/,
  );
});

test('stable versions alone update latest', () => {
  assert.equal(releaseMetadata(input).latest, true);
  assert.equal(
    releaseMetadata({ ...input, event: { inputs: { version: 'v1.2.3-alpha', publish: false } } })
      .latest,
    false,
  );
});

test('rejects malformed versions, commits, repositories and unexpected events', () => {
  for (const version of [
    'latest',
    'v01.2.3',
    'v1.2.3+build',
    'v1.2.3-01',
    'v1.2.3\nlatest',
    'v1.2.3\n',
  ]) {
    assert.throws(() => releaseMetadata({ ...input, event: { inputs: { version } } }), /version/);
  }
  assert.throws(() => releaseMetadata({ ...input, sha: 'main' }), /commit/);
  assert.throws(() => releaseMetadata({ ...input, sha: `${input.sha}\n` }), /commit/);
  assert.throws(() => releaseMetadata({ ...input, repository: 'owner/repo\n' }), /repository/);
  assert.throws(
    () => releaseMetadata({ ...input, repository: 'owner/repo\ninjected' }),
    /repository/,
  );
  assert.throws(() => releaseMetadata({ ...input, eventName: 'push' }), /event/);
});
