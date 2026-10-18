import { createServer } from 'node:http';

/** Compatible HTTP inference fixture; all application routes and storage remain real. */
export async function startProvider() {
  let mode = 'answer';
  let calls = 0;
  const active = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404);
      return response.end();
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    const content = mode === 'hold' ? 'Partial matrix answer ' : 'Provider matrix answer.';
    if (!input.stream) {
      response.setHeader('content-type', 'application/json');
      return response.end(
        JSON.stringify({
          id: 'fixture',
          model: input.model,
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    }
    streamAnswer(response, input.model, content, mode, active);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    get calls() {
      return calls;
    },
    setMode(next) {
      mode = next;
    },
    async close() {
      for (const response of active) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function streamAnswer(response, model, content, mode, active) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  chunk({ role: 'assistant', content });
  if (mode === 'answer') {
    chunk({}, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  active.add(response);
  const timer = setInterval(() => response.write(': keepalive\n\n'), 1_000);
  response.on('close', () => {
    clearInterval(timer);
    active.delete(response);
  });
}
