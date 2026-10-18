import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseMetadata({ eventName, event, ref, sha, repository }) {
  if (!['workflow_dispatch', 'release'].includes(eventName))
    throw new Error('Unsupported release event');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected an exact commit SHA');
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Invalid repository');
  const version = eventName === 'release' ? event.release?.tag_name : event.inputs?.version;
  const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
  const semver = new RegExp(
    `^v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?$`,
  );
  // Docker tags cannot contain SemVer build metadata; accept release/prerelease versions only.
  if (typeof version !== 'string' || !semver.test(version) || version.length > 128)
    throw new Error('Expected a version such as v1.2.3 or v1.2.3-rc.1');
  const latest = !version.includes('-');
  const publish =
    eventName === 'release' || event.inputs?.publish === true || event.inputs?.publish === 'true';
  if (eventName === 'release') {
    if (ref !== `refs/tags/${version}`) throw new Error('Release tag does not match checkout');
    if (event.release.prerelease !== !latest)
      throw new Error('Release prerelease flag must match version');
  } else if (publish && ref !== 'refs/heads/main') {
    throw new Error('Manual publication requires the main branch');
  }
  return { version, image: `ghcr.io/${repository.toLowerCase()}`, revision: sha, publish, latest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = releaseMetadata({
    eventName: process.env.GITHUB_EVENT_NAME,
    event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}
