import { AGENT_STREAM_TOPIC } from '@mastra/core/agent/durable';
import { createRuntime } from './runtime.mjs';

const send = (message) => {
  if (process.connected) process.send(message);
};
const runtime = await createRuntime(JSON.parse(process.argv[2]), send);
const readers = new Map();

function consume(result, channel) {
  const reader = result.output.fullStream.getReader();
  readers.set(channel, reader);
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        send({ event: 'chunk', channel, chunk: value });
      }
      send({ event: 'done', channel });
    } catch (error) {
      send({ event: 'stream-error', channel, error: String(error) });
    }
  })();
}

process.on('message', async ({ id, action, runId, channel = action, force = false }) => {
  try {
    let value;
    if (action === 'start') {
      const result = await runtime.agent.stream('Please respond', { maxSteps: 4 });
      consume(result, 'start');
      value = result.runId;
    } else if (action === 'observe') {
      consume(await runtime.agent.observe(runId, { idleTimeoutMs: 5_000 }), channel);
    } else if (action === 'recover') {
      consume(await runtime.agent.recover(runId, { force }), 'recover');
    } else if (action === 'active') {
      value = await runtime.agent.listActiveRuns();
    } else if (action === 'abort') {
      value = runtime.agent.abortRunStream(runId);
    } else if (action === 'detach') {
      await readers.get(channel)?.cancel();
    } else if (action === 'effects') {
      value = runtime.effects();
    } else if (action === 'history') {
      value = await runtime.agent.pubsub.getHistory(AGENT_STREAM_TOPIC(runId));
    } else {
      throw new Error(`Unknown command: ${action}`);
    }
    send({ id, value });
  } catch (error) {
    send({ id, error: error.stack });
  }
});

send({ event: 'ready' });
