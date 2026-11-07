/** Child-process worker for the isolated real Agent coding smoke evaluation. */
import { realpath, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Agent } from '../agent/Agent.js';
import { TrustManager } from '../agent/TrustManager.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { OllamaClient } from '../llm/OllamaClient.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { RunPolicyManager } from '../services/RunPolicyManager.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { createBuiltInTools } from '../tools/createBuiltInTools.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityEventType } from '../types/index.js';

async function main(): Promise<void> {
  const [model, endpoint, output, contextSize, maxTokens] = process.argv.slice(2);
  const workspace = process.env.ALLY_CODING_WORKSPACE;
  const dataDirectory = process.env.ALLY_DATA_DIR;
  if (!workspace || !dataDirectory
    || await realpath(workspace) !== await realpath(process.cwd())
    || dirname(await realpath(dataDirectory)) !== dirname(await realpath(process.cwd()))) {
    throw new Error('Coding worker requires an isolated workspace and ALLY_DATA_DIR from eval:coding');
  }
  if (model === '--check-environment') {
    process.stdout.write('Worker environment ready.\n');
    return;
  }
  if (!model || !endpoint || !output) throw new Error('Coding worker requires model, endpoint, and output');
  const config = { ...DEFAULT_CONFIG, model, endpoint, context_size: Number(contextSize), max_tokens: Number(maxTokens), temperature: 0, permission_mode: 'allow-all' as const, stream_responses: false, tool_call_activity_timeout: 0 };
  const stream = new ActivityStream();
  const allowedTools = ['read', 'apply-patch', 'write', 'bash', 'grep', 'glob'];
  const manager = new ToolManager(createBuiltInTools(stream, config).filter(tool => allowedTools.includes(tool.name)));
  const registry = ServiceRegistry.getInstance();
  const policy = new RunPolicyManager({ interaction: 'none', execution: 'headless', completion: 'chat', authorizationPresetId: 'coding-eval' });
  const trust = new TrustManager('allow-all', stream);
  trust.setRunPolicyManager(policy);
  trust.setRunAuthorizationPolicy({ allowed_tools: allowedTools.filter(name => name !== 'bash'), allowed_bash_commands: [{ match: 'exact', value: 'node --test' }] }, { strict: true });
  registry.registerInstance('run_policy_manager', policy);
  registry.registerInstance('trust_manager', trust);
  const permissions = new PermissionManager(trust);
  registry.registerInstance('tool_manager', manager);
  registry.registerInstance('read_state_manager', new ReadStateManager());
  const client = new OllamaClient({ endpoint, modelName: model, temperature: 0, contextSize: config.context_size, maxTokens: config.max_tokens, reasoningEffort: 'low' });
  const agent = new Agent(client, manager, stream, { config, allowedTools, isOnceMode: true }, undefined, permissions);
  registry.registerInstance('agent', agent);
  const toolResults: unknown[] = [];
  let successfulTestRun = false;
  const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_END, event => {
    toolResults.push(event);
    const result = event.data?.result;
    if (event.data?.toolName === 'bash' && result?.success && result?.return_code === 0) successfulTestRun = true;
  });
  const started = Date.now();
  try {
    const answer = await agent.sendMessage('Fix rangeSize in range.js: count both inclusive endpoints, and return zero for a reversed range. Inspect the source and existing test before editing. Keep range.test.js unchanged. Run exactly `node --test` to verify the repair, then report the result. Work only in this fixture; do not commit.');
    await writeFile(output, JSON.stringify({ answer, elapsedMs: Date.now() - started, successfulTestRun, toolResults, messages: agent.getMessages() }, null, 2));
  } finally {
    unsubscribe();
    await agent.cleanup();
  }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
