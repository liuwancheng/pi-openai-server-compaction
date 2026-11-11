// Real Pi RPC + a synthetic Responses server. No credentials or external model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const temp = await mkdtemp(join(tmpdir(), 'pi-local-compaction-rpc-'));
const home = join(temp, 'agent');
const cwd = join(temp, 'work');
const requests = [];
const failures = [];
const marker = 'MOCK-ORBIT-7392';
const artifact = { type: 'compaction', id: 'cmp_mock', encrypted_content: 'mock-encrypted-context' };
let failRemote = false;
let summaryFailureMode;
let responseCount = 0;

const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer mock-key');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const compacting = body.input?.at(-1)?.type === 'compaction_trigger';
    if (compacting) {
      assert.equal(req.headers['chatgpt-account-id'], undefined);
      assert.equal(req.headers.originator, undefined);
      assert.equal(body.store, false);
      if (failRemote) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic compaction unsupported' } }));
        return;
      }
    }
    const input = JSON.stringify(body.input);
    const replaying = body.input?.some(item => item.type === 'compaction');
    const summarizing = Boolean(summaryFailureMode) || /summariz/i.test(String(body.instructions)) || /<conversation>/i.test(input);
    const lastUser = JSON.stringify(body.input?.findLast(item => item.role === 'user'));
    const answer = summarizing && summaryFailureMode === 'empty' ? ''
      : summarizing ? 'Portable synthetic summary (exact identifier redacted).'
      : /DROP-THIS-ANSWER/.test(lastUser) ? 'DROP-THIS-ANSWER'
      : replaying ? marker
      : /invent/i.test(input) ? marker : 'OK';
    const id = `resp_mock_${++responseCount}`;
    const output = compacting ? [artifact] : [{ type: 'message', id: `msg_${responseCount}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }];
    const incomplete = summarizing && summaryFailureMode === 'length';
    const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed', ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), model: body.model, output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: compacting ? artifact : { ...output[0], content: [] } });
    if (!compacting) {
      event({ type: 'response.content_part.added', item_id: output[0].id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event({ type: 'response.output_text.delta', item_id: output[0].id, output_index: 0, content_index: 0, delta: answer });
      event({ type: 'response.output_text.done', item_id: output[0].id, output_index: 0, content_index: 0, text: answer });
    }
    event({ type: 'response.output_item.done', output_index: 0, item: output[0] });
    event({ type: incomplete ? 'response.incomplete' : 'response.completed', response });
    res.end();
  } catch (error) {
    failures.push(error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = id => ({ id, name: id, api: 'openai-responses', reasoning: true, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 });
await mkdir(home, { recursive: true });
await mkdir(join(cwd, '.pi'), { recursive: true });
await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-responses', baseUrl, apiKey: 'mock-key', models: [model('mock-sol'), model('mock-terra')] } } }));
await writeFile(join(home, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
const configFile = join(cwd, '.pi/openai-server-compaction.json');
const editProbe = join(temp, 'edit-probe.mjs');
await writeFile(editProbe, `export default function(pi) {
  let mode;
  pi.registerCommand('test-omit', {description: 'Synthetic omission', handler: () => {mode='tail';}});
  pi.registerCommand('test-edit-prefix', {description: 'Synthetic prefix edit', handler: () => {mode='prefix';}});
  pi.registerCommand('test-custom', {description: 'Synthetic custom note', handler: () => {pi.sendMessage({customType:'synthetic-note',content:'SYNTHETIC-CUSTOM-NOTE',display:false});}});
  pi.on('turn_end', (event, ctx) => {
    if (!mode) return;
    const targetId = mode === 'tail' ? event.messageEntryId : ctx.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user').id;
    const replacement = mode === 'tail' ? null : {content: 'Edited synthetic prefix.'};
    mode = undefined;
    return {entries: [...event.entries, {type:'context_edit', targetId, replacement}]};
  });
}`);
await writeFile(configFile, JSON.stringify({ enabled: true, remoteCompactionProviders: ['local'] }));
const clients = new Set();
async function start(sessionFile) {
  const client = new RpcClient({ cliPath, cwd, model: 'local/mock-sol', env: { PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_OPENAI_SERVER_COMPACTION_ENABLED: '1', PI_OPENAI_SERVER_COMPACTION_NOTIFY: '0' }, args: ['--approve', '--no-extensions', '-e', join(root, 'src/index.ts'), '-e', editProbe, '--no-tools', '--no-mcp', '--session-dir', join(temp, 'sessions'), ...(sessionFile ? ['--session', sessionFile] : [])] });
  clients.add(client);
  await client.start();
  await client.setAutoRetry(false);
  return client;
}
async function stop(client) { await client.stop(); clients.delete(client); }
async function prompt(client, text) {
  await client.promptAndWait(text, undefined, 30000);
  const answer = await client.getLastAssistantText();
  assert.ok(answer, `Missing assistant text. ${client.getStderr()}`);
  assert.equal(failures.length, 0, failures.map(e => e.message).join('\n'));
  const currentUser = last().input?.findLast(item => item.role === 'user');
  const currentText = Array.isArray(currentUser?.content) ? currentUser.content.map(part => part.text ?? '').join('') : currentUser?.content;
  assert.equal(currentText, text, 'Remote replay must include the current user prompt, not only committed history');
  return answer;
}
function last() { return requests.at(-1); }
function hasArtifact(body) { return body.input?.some(item => item.type === 'compaction'); }
function unchangedTransport(body) {
  assert.notEqual(body.store, true);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.context_management, undefined);
}

try {
  let client = await start();
  await prompt(client, 'Invent a fictional project identifier.');
  unchangedTransport(last());
  await prompt(client, 'Synthetic filler '.repeat(150) + ' Reply OK.');
  const compact = await client.compact('Redact exact identifiers from the portable summary.');
  assert.equal(compact.details?.remoteCompaction?.implementation, 'responses_compaction_v2', JSON.stringify({ compact, requestTypes: requests.map(body => ({ model: body.model, inputTypes: body.input?.map(item => item.type ?? item.role) })), failures: failures.map(e => e.message), stderr: client.getStderr() }));
  assert.ok(compact.details.remoteCompaction.replacementHistory.some(item => item.type === 'compaction'));
  const sessionFile = (await client.getState()).sessionFile;
  const rows = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'compaction' && row.details?.remoteCompaction));
  assert.equal(await prompt(client, 'What was the fictional identifier?'), marker);
  assert.ok(hasArtifact(last()), 'Post-compaction request must replay remote artifact');
  assert.ok(last().input.some(item => item.role === 'developer' || item.role === 'system'), 'Pi 1.5 prompt messages must survive history replacement');
  unchangedTransport(last());
  console.log('PASS: real RPC compaction, persisted artifact, HTTP replay');
  await client.prompt('/test-omit');
  await prompt(client, 'Reply DROP-THIS-ANSWER for a synthetic omission.');
  await prompt(client, 'Reply OK after an omitted assistant attempt.');
  assert.ok(hasArtifact(last()), 'An edited tail can still use the unchanged artifact');
  assert.ok(!last().input.filter(item => item.role === 'assistant').some(item => JSON.stringify(item).includes('DROP-THIS-ANSWER')), 'Omitted assistant attempt must not be replayed');
  console.log('PASS: context-edit omission excludes the edited tail');
  await client.prompt('/test-custom');
  await prompt(client, 'Reply OK after an extension-authored note.');
  assert.ok(JSON.stringify(last().input).includes('SYNTHETIC-CUSTOM-NOTE'), 'Extension-authored context must survive remote replay');
  console.log('PASS: extension-authored messages survive remote replay');

  const repeated = await client.compact('Summarize again without exact identifiers.');
  assert.ok(repeated.details?.remoteCompaction);
  const repeatedRequest = requests.findLast(body => body.input?.at(-1)?.type === 'compaction_trigger');
  assert.ok(hasArtifact(repeatedRequest), 'Repeated compaction must use previous remote history');
  await prompt(client, 'Recall after a second compaction.');
  assert.ok(hasArtifact(last()));
  console.log('PASS: repeated compaction uses prior opaque history');

  await stop(client);
  client = await start(sessionFile);
  await prompt(client, 'What was the fictional identifier after resume?');
  assert.ok(hasArtifact(last()), 'Resume must reconstruct artifact');
  await client.clone();
  await prompt(client, 'Recall after cloning.');
  assert.ok(hasArtifact(last()), 'Clone must restore compatible artifact');
  await client.setModel('local', 'mock-terra');
  await prompt(client, 'Record the new alternate-model decision ALTERNATE-DECISION. Reply OK.');
  assert.ok(!hasArtifact(last()), 'Incompatible model must use portable context');
  await client.setModel('local', 'mock-sol');
  await prompt(client, 'Recall after switching back.');
  assert.ok(!hasArtifact(last()), 'Completed cross-model dialogue must use portable context');
  assert.ok(JSON.stringify(last().input).includes('ALTERNATE-DECISION'), 'Switch-back must preserve progress made by the other model');
  const crossModelSession = (await client.getState()).sessionFile;
  await stop(client);
  client = await start(crossModelSession);
  await prompt(client, 'Recall after resuming the cross-model session.');
  assert.ok(!hasArtifact(last()));
  assert.ok(JSON.stringify(last().input).includes('ALTERNATE-DECISION'));
  console.log('PASS: resume, clone, cross-model progress and resumed portability');
  const forkMessages = await client.getForkMessages();
  assert.ok(forkMessages.length);
  await client.fork(forkMessages[0].entryId);
  await prompt(client, 'Reply OK on a branch before compaction.');
  assert.ok(!hasArtifact(last()), 'Fork before compaction must not inherit remote state');
  console.log('PASS: fork before compaction clears incompatible history');
  // Go back to the saved compacted session and edit a prefix encoded in its artifact.
  await client.switchSession(sessionFile);
  await client.prompt('/test-edit-prefix');
  await prompt(client, 'Reply OK while editing the compacted prefix.');
  await prompt(client, 'Reply OK after the prefix edit.');
  assert.ok(!hasArtifact(last()), 'An artifact cannot undo an edit to its compacted prefix');
  console.log('PASS: edited compacted prefix falls back to portable context');

  await writeFile(configFile, JSON.stringify({ enabled: false, remoteCompactionProviders: ['local'] }));
  // The existing process uses the explicit enabled env override; a new process below tests disable.
  await stop(client);
  const disabled = new RpcClient({ cliPath, cwd, model: 'local/mock-sol', env: { PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_OPENAI_SERVER_COMPACTION_ENABLED: '0' }, args: ['--approve', '--no-extensions', '-e', join(root, 'src/index.ts'), '--no-tools', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--thinking', 'low', '--session', sessionFile] });
  clients.add(disabled);
  await disabled.start();
  await prompt(disabled, 'Reply OK with remote compaction disabled.');
  assert.ok(!hasArtifact(last()), 'Disabled extension must not replay artifact');
  unchangedTransport(last());
  await stop(disabled);
  console.log('PASS: disabled extension preserves ordinary HTTP requests');

  await writeFile(configFile, JSON.stringify({ enabled: true, remoteCompactionProviders: ['local'] }));
  client = await start();
  await prompt(client, 'Invent a fictional identifier for the fallback test.');
  await prompt(client, 'Synthetic filler '.repeat(150) + ' Reply OK.');
  failRemote = true;
  const fallback = await client.compact('Summarize briefly.');
  assert.ok(fallback.summary);
  assert.equal(fallback.details?.remoteCompaction, undefined);
  await prompt(client, 'Reply OK after failed remote compaction.');
  assert.ok(!hasArtifact(last()));
  console.log('PASS: remote failure falls back to portable summary');
  await stop(client);
  failRemote = false;
  const { generatePortableSummary } = await import('../../src/remote-compaction.ts');
  for (summaryFailureMode of ['length', 'empty']) {
    await assert.rejects(() => generatePortableSummary({
      model: { ...model('mock-sol'), provider: 'local', baseUrl }, apiKey: 'mock-key',
      messages: [{ role: 'user', content: 'Synthetic summary test.', timestamp: Date.now() }],
      firstKeptEntryId: 'test-entry', tokensBefore: 100,
    }), /Portable summary/);
  }
  summaryFailureMode = undefined;
  client = await start();
  await prompt(client, 'Invent a fictional identifier for summary-failure testing.');
  await prompt(client, 'Synthetic filler '.repeat(150) + ' Reply OK.');
  summaryFailureMode = 'empty';
  const hostFallback = await client.compact('Summarize briefly.');
  assert.equal(hostFallback.details?.remoteCompaction, undefined, 'Invalid portable summaries must not save an opaque-only checkpoint');
  const failedEntries = await client.getEntries();
  assert.ok(!failedEntries.entries.some(entry => entry.type === 'compaction' && entry.details?.remoteCompaction), 'No opaque-only checkpoint may be persisted without a usable portable summary');
  summaryFailureMode = undefined;
  await prompt(client, 'Reply OK after failed portable summaries.');
  await stop(client);
  console.log('PASS: truncated/empty summaries rejected; no invalid checkpoint persisted');
  assert.equal(failures.length, 0);
  console.log('ALL LOCAL RPC TESTS PASSED (synthetic backend, no external calls)');
} finally {
  for (const client of clients) await client.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
