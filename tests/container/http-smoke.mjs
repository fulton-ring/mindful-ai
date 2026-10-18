import assert from 'node:assert/strict';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
const request = async (path, method = 'GET', data) => {
  const response = await fetch(new URL(path, origin), {
    method,
    ...(data === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response;
};
const json = async (path, method, data) => (await request(path, method, data)).json();
assert.equal((await json('/api/config')).auth.mode, 'none');
assert.equal((await json('/api/account/policy')).planId, 'default');
const note = await json('/api/notes', 'POST', { markdown: 'Container smoke note.' });
let conversation;
try {
  await json(`/api/notes/${note.id}/title`, 'PATCH', { title: 'Container smoke' });
  const markdown = 'Container smoke edited — café, λ and exact bytes.';
  const saved = await json(`/api/notes/${note.id}`, 'PATCH', {
    operationId: crypto.randomUUID(),
    baseRevision: note.revision,
    markdown,
    provenance: [],
  });
  assert.equal(saved.revision, 1);
  assert.equal((await json(`/api/notes/${note.id}`)).markdown, markdown);
  assert.equal(await (await request(`/api/notes/${note.id}/export`)).text(), markdown);
  conversation = await json('/api/conversations', 'POST', {});
  const bytes = 'Container attachment: café, λ and exact bytes.\n';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/plain' }), 'container-smoke.txt');
  const upload = await fetch(new URL(`/api/chat/attachments/${conversation.id}`, origin), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(upload.ok, `Upload: ${upload.status} ${await upload.clone().text()}`);
  const attachment = await upload.json();
  assert.equal(
    await (await request(`/api/chat/attachments/${conversation.id}/${attachment.id}`)).text(),
    bytes,
  );
} finally {
  await request(`/api/notes/${note.id}`, 'DELETE');
  if (conversation) await request(`/api/conversations/${conversation.id}`, 'DELETE');
}
assert.equal((await fetch(new URL(`/api/notes/${note.id}`, origin))).status, 404);
console.log(
  'Container API: default account, note revisions/export/deletion and exact attachment upload/download passed.',
);
