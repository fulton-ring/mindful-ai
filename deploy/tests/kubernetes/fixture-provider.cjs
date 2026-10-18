const http = require('node:http');
let mode = 'answer';
let calls = 0;
const active = new Set();
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'fixture-model', object: 'model', owned_by: 'local-validation' }],
      }),
    );
  }
  if (req.url === '/fixture/status') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ mode, calls, active: active.size }));
  }
  if (req.url === '/fixture/mode' && req.method === 'POST') {
    const value = JSON.parse(body).mode;
    if (!['answer', 'hold'].includes(value)) {
      res.writeHead(400);
      return res.end();
    }
    mode = value;
    return res.end(JSON.stringify({ mode }));
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    return res.end();
  }
  const input = JSON.parse(body);
  calls++;
  const content = mode === 'hold' ? 'Partial ' : 'Kubernetes fixture answer.';
  if (!input.stream) {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        id: 'fixture-' + calls,
        object: 'chat.completion',
        created: 1,
        model: input.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fixture-' + calls, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content });
  if (mode === 'answer') {
    chunk({}, 'stop');
    return res.end('data: [DONE]\n\n');
  }
  active.add(res);
  const timer = setInterval(() => res.write(': keepalive\n\n'), 1000);
  res.on('close', () => {
    clearInterval(timer);
    active.delete(res);
  });
});
server.listen(8080, '0.0.0.0');
