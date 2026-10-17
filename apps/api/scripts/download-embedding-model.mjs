/** Build/install only. Runtime model loading explicitly prohibits remote downloads. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
// Checked against the immutable official Hugging Face revision. The ONNX digest
// also equals its repository Git LFS SHA-256 object ID.
export const EMBEDDING_MODEL_FILES = {
  'README.md': '63ea99bf681a2e9eda4f6a537d5ed8fda95d1677111656da37e9cfd080c3af02',
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function downloadFile(directory, file, expected) {
  const destination = join(directory, file);
  try {
    if (sha256(await readFile(destination)) === expected) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const url = `https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw new Error(`Embedding model download failed: ${file} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Embedding model checksum mismatch: ${file}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function downloadEmbeddingModel(destination) {
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(EMBEDDING_MODEL_FILES).map(([file, expected]) =>
      downloadFile(directory, file, expected),
    ),
  );
  const manifest = {
    model: EMBEDDING_MODEL_ID,
    revision: EMBEDDING_MODEL_REVISION,
    dimensions: 384,
    dtype: 'q8',
    license: 'Apache-2.0',
    files: EMBEDDING_MODEL_FILES,
  };
  await writeFile(join(directory, 'model-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node download-embedding-model.mjs DESTINATION');
  const manifest = await downloadEmbeddingModel(process.argv[2]);
  console.log(`Bundled ${manifest.model}@${manifest.revision} in ${resolve(process.argv[2])}`);
}
