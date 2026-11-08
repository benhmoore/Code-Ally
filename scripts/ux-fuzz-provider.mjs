#!/usr/bin/env node
/** Deterministic loopback-only Ollama fixture. Never contacts a model or executes commands.
 * node scripts/ux-fuzz-provider.mjs --port 11435 --workdir /tmp/ally-ux --trace /tmp/ally-ux/trace.jsonl
 * Prompt markers: UX:markdown|thinking|question|permission|background|delegate|failure|slow|tool-error.
 * Each marker produces at most one tool per user turn; subsequent tool results get a final answer.
 */
import http from 'node:http';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const port = Number(option('port', '11435'));
const workdir = resolve(option('workdir', join(tmpdir(), 'ally-ux-fixture')));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Port must be 1024..65535');
if (workdir === parse(workdir).root || workdir === process.cwd())
  throw Error('Use an isolated fixture working directory');
mkdirSync(workdir, { recursive: true });
const tracePath = resolve(option('trace', join(workdir, 'provider-trace.jsonl')));
const maxRequests = Number(option('max-requests', '500'));
const delay = Number(option('delay-ms', '25'));
if (!(maxRequests > 0 && maxRequests <= 5000) || !(delay >= 0 && delay <= 1000))
  throw Error('Invalid request/delay bounds');
let sequence = 0;
const failed = new Set();
const log = data => appendFileSync(tracePath, JSON.stringify({ ...data }) + '\n');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const model = {
  name: 'ux-fuzz:latest',
  model: 'ux-fuzz:latest',
  modified_at: '2026-01-01T00:00:00Z',
  size: 1,
  digest: 'fixture',
  details: { format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '1B', quantization_level: 'Q4_0' },
  capabilities: ['completion', 'tools', 'thinking'],
};
const call = (name, arguments_) => ({ function: { name, arguments: arguments_ } });
function response(body) {
  const messages = body.messages || [];
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (
      message.role === 'user' &&
      !/^<(?:system-reminder)|^\[(?:Agent |Background watch\])/.test(String(message.content || '').trimStart())
    )
      lastUser = index;
  });
  const prompt =
    typeof messages[lastUser]?.content === 'string'
      ? messages[lastUser].content
      : JSON.stringify(messages[lastUser]?.content || '');
  if (
    prompt.startsWith('You are helping a user create a custom AI agent.') &&
    prompt.includes('IMPORTANT: Respond ONLY with valid JSON in this exact format:')
  )
    return {
      marker: 'agent-generation',
      content: JSON.stringify({
        name: 'fixture-helper',
        description: 'A deterministic helper for isolated UX tests.',
        systemPrompt:
          'You are a deterministic fixture helper. Reply with concise fixture results and use no tools unless the user requests a fixture action.',
      }),
    };
  const marker = /UX:([a-z0-9-]+)/i.exec(prompt)?.[1]?.toLowerCase() || 'markdown';
  const after = messages.slice(lastUser + 1);
  const previousCalls = after.flatMap(message => message.tool_calls || []);
  const used = name => previousCalls.some(c => c.function?.name === name);
  const names = (body.tools || []).map(tool => tool.function?.name);
  const desired = (calls, extra = {}) => {
    const list = Array.isArray(calls) ? calls : [calls];
    const missing = [...new Set(list.map(c => c.function.name))].filter(name => !names.includes(name));
    if (missing.length) {
      if (
        names.includes('tool-search') &&
        !previousCalls.some(
          c => c.function?.name === 'tool-search' && JSON.stringify(c.function.arguments).includes(missing[0])
        )
      )
        return {
          marker,
          content: 'Loading fixture tools.',
          tool_calls: [call('tool-search', { query: `select:${missing.join(',')}` })],
        };
      return { marker, content: `Fixture unavailable tools: ${missing.join(', ')}` };
    }
    return { marker, content: `I will exercise the ${marker} fixture.`, tool_calls: list, ...extra };
  };
  if (marker === 'parallel' && !used('agent'))
    return desired(
      [1, 2, 3].map(n =>
        call('agent', {
          task_prompt:
            `UX:child${n} Reply after the fixture delay with child ${n} complete. Do not use tools.\n` +
            'Inspect this bounded deterministic fixture context for display wrapping. '.repeat(15),
          description: `Fixture parallel child ${n}`,
          thoroughness: 'quick',
        })
      )
    );
  if (marker === 'message' && !used('agent'))
    return desired(
      call('agent', {
        task_prompt:
          'UX:messenger Send one message to parent, then finish. Do not send further messages after a reply.',
        description: 'Fixture messenger',
        thoroughness: 'quick',
      })
    );
  if (marker === 'messenger' && !used('send-message'))
    return desired(
      call('send-message', {
        recipient_id: 'parent',
        message: 'Fixture child requests one parent reply. Fixture messenger ready.',
      })
    );
  if (marker === 'message' && used('agent') && !used('send-message')) {
    const findId = value => {
      if (typeof value === 'string') {
        try {
          return findId(
            JSON.parse(
              value.slice(
                value.indexOf('{') >= 0 ? value.indexOf('{') : 0,
                value.lastIndexOf('}') >= 0 ? value.lastIndexOf('}') + 1 : undefined
              )
            )
          );
        } catch {
          return undefined;
        }
      }
      if (!value || typeof value !== 'object') return undefined;
      if (typeof value.agent_id === 'string') return value.agent_id;
      if (typeof value.task_id === 'string') return value.task_id;
      for (const item of Object.values(value)) {
        const found = findId(item);
        if (found) return found;
      }
    };
    const recipient = findId(after.filter(m => m.role === 'tool'));
    if (recipient)
      return desired(
        call('send-message', {
          recipient_id: recipient,
          message: 'Fixture parent received your message. No further acknowledgement needed.',
        })
      );
  }
  if (marker === 'plan') {
    if (!used('enter-plan-mode')) return desired(call('enter-plan-mode', {}));
    if (!used('write-plan'))
      return desired(
        call('write-plan', {
          name: 'ux-fixture-plan',
          content:
            '# Fixture plan\n\n1. Review isolated fixture.\n2. Confirm the plan approval dialog.\n3. Finish without running commands.\n',
        })
      );
    if (!used('exit-plan-mode')) return desired(call('exit-plan-mode', {}));
  }
  if (
    after.some(message => message.role === 'tool' || message.tool_calls?.length) &&
    !previousCalls.every(c => c.function?.name === 'tool-search')
  )
    return { marker, content: `Fixture ${marker} complete. Tool result received; ready for your next message.` };
  const plans = {
    freeform: call('ask-user-question', {
      questions: [{ header: 'Fixture text', question: 'What fixture label should I use?' }],
    }),
    question: call('ask-user-question', {
      questions: [
        {
          header: 'Fixture choice',
          question: 'Which fixture color should I use?',
          options: [
            { label: 'Blue', description: 'Use blue for the fixture.' },
            { label: 'Green', description: 'Use green for the fixture.' },
          ],
        },
      ],
    }),
    review: call('write', {
      file_path: join(workdir, 'review-demo.txt'),
      content: 'Deterministic bounded reviewer UX fixture.\n',
    }),
    'delegate-fail': call('agent', {
      task_prompt: 'UX:child-fail This fixture must receive an explicit provider failure. Do not recover or use tools.',
      description: 'Fixture failed child',
      thoroughness: 'quick',
    }),
    permission: call('write', {
      file_path: join(workdir, 'permission-demo.txt'),
      content: 'Deterministic UX fixture permission test.\n',
    }),
    foreground: call('bash', {
      command:
        'node -e \'let n=0;const t=setInterval(()=>{console.log("fixture foreground tick "+(++n));if(n===10)clearInterval(t)},1000)\'',
      run_in_background: false,
      timeout: 20,
      working_dir: workdir,
      description: 'Run ten bounded foreground ticks',
    }),
    timeout: call('bash', {
      command:
        'node -e \'let n=0;const t=setInterval(()=>{console.log("fixture timeout tick "+(++n));if(n===6)clearInterval(t)},1000)\'',
      run_in_background: false,
      timeout: 2,
      working_dir: workdir,
      description: 'Continue six bounded ticks after two second wait',
    }),
    background: call('bash', {
      command:
        'node -e \'let n=0;const t=setInterval(()=>{console.log("fixture tick "+(++n));if(n===4)clearInterval(t)},500)\'',
      run_in_background: true,
      description: 'Run bounded fixture ticks',
    }),
    delegate: call('agent', {
      task_prompt: 'UX:child Reply with Fixture child complete. Do not use tools.',
      agent_type: 'task',
      description: 'Fixture child',
      thoroughness: 'quick',
    }),
    'command-error': call('bash', {
      command: 'node -e \'console.error("fixture intentional command failure");process.exit(7)\'',
      working_dir: workdir,
      description: 'Fixture command exits seven',
    }),
    'tool-error': call('read', { file_path: join(workdir, 'intentionally-missing.txt') }),
  };
  if (plans[marker]) return desired(plans[marker]);
  if (/^child[123]?$/.test(marker))
    return { marker, startDelay: Number(marker.slice(-1)) * 2500 || 0, content: `Fixture ${marker} complete.` };
  return {
    marker,
    thinking:
      marker === 'thinking' ? 'I am checking the fixture response shape. The result is deterministic.\n' : undefined,
    content:
      marker === 'slow'
        ? 'Streaming fixture progress; press Escape to abort.\n'.repeat(150)
        : '# Fixture response\n\n**Streaming** text with `inline code`, Unicode café 界, and a [local link](https://example.invalid).\n\n- First item\n- Second item\n\n| State | Result |\n| --- | --- |\n| deterministic | ready |\n\n```js\nconsole.log("fixture");\n```\n\nFixture complete.',
  };
}
const server = http.createServer(async (req, res) => {
  const id = ++sequence;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (id > maxRequests) return json(429, { error: 'Fixture request limit reached' });
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
        json(413, { error: 'Fixture body limit exceeded' });
        return;
      }
    }
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url?.split('?')[0];
    log({
      event: 'request',
      id,
      method: req.method,
      url,
      model: body.model,
      tools: (body.tools || []).map(t => t.function?.name),
      messages: body.messages,
    });
    if (url === '/v1/systemone') {
      const readiness =
        body.state?.human_task === 'Read the project README.' &&
        body.state?.proposed_action === 'Delete the project README.';
      const verdict = readiness
        ? 'deny'
        : body.model === 'ux-review-deny'
          ? 'deny'
          : body.model === 'ux-review-ask'
            ? 'ask'
            : 'allow';
      log({ event: 'review', id, model: body.model, readiness, verdict, state: body.state });
      await sleep(readiness ? 20 : 800);
      if (!readiness && body.model === 'ux-review-fallback')
        return json(503, { error: 'Deterministic reviewer unavailable fixture' });
      return json(200, {
        answers: {
          permission: {
            type: 'choice',
            choice: verdict,
            probabilities: {
              allow: verdict === 'allow' ? 0.98 : 0.01,
              ask: verdict === 'ask' ? 0.98 : 0.01,
              deny: verdict === 'deny' ? 0.98 : 0.01,
            },
          },
        },
      });
    }
    if (url === '/health') return json(200, { ok: true, workdir: realpathSync(workdir), requests: sequence });
    if (url === '/api/version') return json(200, { version: '0.9.0-fixture' });
    if (url === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: [{ id: model.name, object: 'model', created: 1767225600, owned_by: 'ux-fixture', context_window: 32768 }] });
    if (url === '/api/tags') return json(200, { models: [model] });
    if (url === '/api/show')
      return json(200, {
        ...model,
        template: '{{ .Messages }}',
        parameters: 'num_ctx 32768',
        model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 32768 },
      });
    if (url !== '/api/chat') return json(404, { error: 'Unknown fixture endpoint' });
    if (!Array.isArray(body.messages)) return json(400, { error: 'messages must be an array' });
    const output = response(body);
    if (output.marker === 'child-fail') {
      log({ event: 'injected-child-failure', id });
      return json(400, { error: 'Deterministic failed child provider fixture' });
    }
    const failureKey = JSON.stringify(body.messages.filter(m => m.role === 'user'));
    if (output.marker === 'failure' && !failed.has(failureKey)) {
      failed.add(failureKey);
      log({ event: 'injected-failure', id });
      return json(503, { error: 'Deterministic transient fixture failure; retry this turn' });
    }
    log({ event: 'response-plan', id, marker: output.marker, tool_calls: output.tool_calls });
    const base = { model: body.model || model.name, created_at: '2026-01-01T00:00:00Z' };
    const final = {
      ...base,
      done: true,
      done_reason: output.tool_calls ? 'tool_calls' : 'stop',
      total_duration: 1000000,
      prompt_eval_count: 30,
      eval_count: 20,
    };
    if (body.stream === false)
      return json(200, {
        ...final,
        message: {
          role: 'assistant',
          content: output.content,
          ...(output.thinking ? { thinking: output.thinking } : {}),
          ...(output.tool_calls ? { tool_calls: output.tool_calls } : {}),
        },
      });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    let completed = false;
    res.on('close', () => {
      if (!completed) log({ event: 'aborted', id });
    });
    const emit = message => {
      if (res.destroyed) return false;
      res.write(
        JSON.stringify({ ...base, message: { role: 'assistant', content: '', ...message }, done: false }) + '\n'
      );
      return true;
    };
    if (output.marker === 'partial-error') {
      emit({ content: 'Partial fixture response retained before connection loss.\n' });
      await sleep(500);
      log({ event: 'injected-partial-stream-failure', id });
      res.destroy();
      return;
    }
    if (output.startDelay) await sleep(output.startDelay);
    if (output.thinking)
      for (const part of output.thinking.match(/.{1,18}|\n/g) || []) {
        if (!emit({ thinking: part })) return;
        await sleep(delay);
      }
    for (const part of output.content.match(/.{1,18}|\n/g) || []) {
      if (!emit({ content: part })) return;
      await sleep(output.marker === 'slow' ? 80 : delay);
    }
    if (output.tool_calls && !emit({ tool_calls: output.tool_calls })) return;
    if (res.destroyed) return;
    completed = true;
    res.end(JSON.stringify({ ...final, message: { role: 'assistant', content: '' } }) + '\n');
    log({ event: 'completed', id });
  } catch (error) {
    log({ event: 'error', id, error: String(error) });
    if (!res.headersSent) json(400, { error: String(error) });
    else res.end();
  }
});
server.on('error', error => {
  console.error(JSON.stringify({ error: String(error), port }));
  process.exitCode = 1;
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => {
  console.log(
    JSON.stringify({ ready: true, endpoint: `http://127.0.0.1:${port}`, model: model.name, workdir, trace: tracePath })
  );
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
