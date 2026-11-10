import { BEHAVIOR_WORKER_STOP, BEHAVIOR_WORKER_CLEANED, BEHAVIOR_WORKER_STOPPING } from './behaviorProcess.js';
import type { BehaviorFactors } from './behaviorFactors.js';
/** One isolated full-Agent behavior case. Launched only by behaviorCampaign. */
import { createHash } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent } from '../agent/Agent.js';
import { TrustManager } from '../agent/TrustManager.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { OllamaClient } from '../llm/OllamaClient.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { AgentManager } from '../services/AgentManager.js';
import { AgentMessagingService } from '../services/AgentMessagingService.js';
import { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';
import { BackgroundTaskRegistry } from '../services/BackgroundTaskRegistry.js';
import { BashProcessManager } from '../services/BashProcessManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { RunPolicyManager } from '../services/RunPolicyManager.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { SessionManager } from '../services/SessionManager.js';
import { TodoManager } from '../services/TodoManager.js';
import { ToolActivationRegistry } from '../services/ToolActivationRegistry.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { createBuiltInTools } from '../tools/createBuiltInTools.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityEventType, type ActivityEvent } from '../types/index.js';
import type { BehaviorVariant } from './behaviorPolicies.js';
import { installBehaviorTransport } from './behaviorTransport.js';
import { confineFixtureTools } from './behaviorWorkspace.js';
import {
  getBehaviorFixture,
  verifyFixtureReadRequirements,
  type BehaviorAssertion,
  type BehaviorCaseId,
  type BehaviorVerification,
} from './behaviorFixtures.js';
import {
  CHECKPOINT_DIRECTION,
  RUNTIME_BEHAVIOR_CASES,
  setupRuntimeBehaviorFixture,
  verifyRuntimeBehaviorFixture,
  type RuntimeBehaviorCaseId,
} from './behaviorRuntimeFixtures.js';

interface WorkerConfig extends BehaviorFactors {
  caseId: string;
  variant: BehaviorVariant;
  model: string;
  endpoint: string;
  contextSize: number;
  maxTokens: number;
  temperature: number;
  reasoningEffort: string;
  seed: number;
  output: string;
  workspace: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main(): Promise<void> {
  const options: WorkerConfig = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  const data = process.env.ALLY_DATA_DIR;
  if (
    !data ||
    (await realpath(options.workspace)) !== (await realpath(process.cwd())) ||
    dirname(await realpath(data)) !== dirname(await realpath(options.workspace))
  ) {
    throw new Error('Behavior worker requires an isolated sibling workspace/data root');
  }
  if (!['baseline', 'outcome', 'exact-edit'].includes(options.variant) || options.contextSize < 32768)
    throw new Error('Invalid behavior variant/context');
  if (
    !['exact', 'historical-unified'].includes(options.editSurface) ||
    !['baseline', 'outcome'].includes(options.promptVariant)
  )
    throw new Error('Behavior worker requires explicit edit surface and prompt factors');
  const started = Date.now();
  const transport = installBehaviorTransport({
    endpoint: options.endpoint,
    variant: options.promptVariant,
    seed: options.seed,
  });
  const requests = transport.requests;
  const toolEvents: Array<{
    id: string;
    parentId?: string;
    owner?: string;
    type: string;
    data: any;
    timestamp: number;
  }> = [];
  const toolArguments = new Map<string, unknown>();
  let writes = Promise.resolve();
  let frozenFleet: unknown[] | undefined;
  let frozenMessages: unknown;
  let frozenTurn: ReturnType<Agent['getTurnSnapshot']> | undefined;
  const extraAssertions: BehaviorAssertion[] = [];
  let error: string | undefined;
  let verification: BehaviorVerification = { passed: false, assertions: [] };
  let steering: unknown;
  const stream = new ActivityStream();
  const registry = ServiceRegistry.getInstance();
  const config = {
    ...DEFAULT_CONFIG,
    model: options.model,
    endpoint: options.endpoint,
    context_size: options.contextSize,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    reasoning_effort: options.reasoningEffort,
    permission_mode: 'allow-all' as const,
    stream_responses: true,
    tool_call_activity_timeout: 0,
    enable_idle_messages: false,
  };
  const configManager = new ConfigManager(join(data, 'config.json'));
  await configManager.initialize();
  configManager.applyRuntimeOverrides(config);
  const tools = createBuiltInTools(stream, config, { editSurface: options.editSurface });
  confineFixtureTools(tools, options.workspace);
  const toolManager = new ToolManager(tools);
  const policy = new RunPolicyManager({
    interaction: 'none',
    execution: 'headless',
    completion: 'chat',
    authorizationPresetId: 'behavior-eval',
  });
  const trust = new TrustManager('allow-all', stream);
  trust.setRunPolicyManager(policy);
  // Preserve production schemas/discovery while denying unrelated effects at execution.
  const safeTools = [
    'read',
    'write',
    'apply-patch',
    'grep',
    'glob',
    'ls',
    'tree',
    'todo-write',
    'tool-search',
    'agent',
    'explore',
    'wait',
    'send-message',
    'cleanup-call',
    'read-checkpoint',
    'read-history',
    'cancel-agent',
  ];
  trust.setRunAuthorizationPolicy(
    {
      allowed_tools: safeTools,
      allowed_bash_commands: [
        { match: 'exact', value: 'node --test' },
        { match: 'exact', value: 'npm test' },
      ],
    },
    { strict: true }
  );
  const permissions = new PermissionManager(trust);
  const background = new BackgroundAgentManager();
  const bash = new BashProcessManager();
  const tasks = new BackgroundTaskRegistry(background, bash, stream);
  const sessions = new SessionManager({ sessionsDir: join(data, 'sessions') });
  await sessions.initialize();
  const messaging = new AgentMessagingService(
    () => agent,
    () => undefined,
    background,
    stream
  );
  registry.registerInstance('config_manager', configManager);
  registry.registerInstance('run_policy_manager', policy);
  registry.registerInstance('trust_manager', trust);
  registry.registerInstance('permission_manager', permissions);
  registry.registerInstance('tool_manager', toolManager);
  registry.registerInstance('read_state_manager', new ReadStateManager());
  registry.registerInstance('tool_activation_registry', new ToolActivationRegistry());
  registry.registerInstance('todo_manager', new TodoManager(stream));
  registry.registerInstance('agent_manager', new AgentManager());
  registry.registerInstance('background_agent_manager', background);
  registry.registerInstance('bash_process_manager', bash);
  registry.registerInstance('background_task_registry', tasks);
  registry.registerInstance('agent_messaging', messaging);
  registry.registerInstance('session_manager', sessions);
  const writeResult = () => {
    writes = writes
      .catch(failure => {
        error = `${error ?? ''} Artifact write failed: ${String(failure)}`;
      })
      .then(async () => {
        const ended = toolEvents.filter(event => event.type === ActivityEventType.TOOL_CALL_END);
        const seen = new Set<string>();
        let repeatedSuccessfulCalls = 0;
        for (const event of ended) {
          if (!event.data?.result?.success) continue;
          const key = hash([event.owner, event.data?.toolName, event.data?.arguments]);
          if (seen.has(key)) repeatedSuccessfulCalls += 1;
          seen.add(key);
        }
        const metrics = {
          elapsedMs: Date.now() - started,
          modelCalls: requests.length,
          toolCalls: ended.length,
          promptTokens: requests.reduce((n, request) => n + (request.response?.usage?.promptTokens ?? 0), 0),
          completionTokens: requests.reduce((n, request) => n + (request.response?.usage?.completionTokens ?? 0), 0),
          totalTokens: requests.reduce((n, request) => n + (request.response?.usage?.totalTokens ?? 0), 0),
          usageComplete: requests.every(
            request =>
              request.httpStatus === 200 &&
              !request.responseTruncated &&
              !request.error &&
              (request.response?.usage.promptTokens ?? 0) > 0
          ),
          failedTools: ended.filter(event => event.data?.result?.success === false).length,
          discoveryCalls: ended.filter(event => event.data?.toolName === 'tool-search').length,
          delegatedAgents: frozenFleet?.length ?? background.listTasks().length,
          repeatedSuccessfulCalls,
        };
        const assertions = [...verification.assertions, ...extraAssertions];
        const result = {
          caseId: options.caseId,
          variant: options.variant,
          editSurface: options.editSurface,
          promptVariant: options.promptVariant,
          passed:
            !error &&
            verification.passed &&
            assertions.every(item => item.passed) &&
            (frozenTurn ?? agent?.getTurnSnapshot())?.state === 'completed',
          error,
          verification: { passed: assertions.every(item => item.passed) && verification.passed, assertions },
          metrics,
          requests,
          messages: frozenMessages ?? agent?.getMessages(),
          toolEvents,
          steering,
          turnState: frozenTurn ?? agent?.getTurnSnapshot(),
          fleet:
            frozenFleet ??
            background.listTasks().map(task => ({
              id: task.id,
              status: task.status,
              error: task.error,
              result: task.result,
              messages: task.completedView?.messages,
            })),
          checkpoint: agent?.getConversationManager().getCheckpoint(),
        };
        await writeFile(options.output + '.tmp', JSON.stringify(result, null, 2));
        await rename(options.output + '.tmp', options.output);
      });
    return writes;
  };
  const client = new OllamaClient({
    endpoint: options.endpoint,
    modelName: options.model,
    contextSize: options.contextSize,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    activityStream: stream,
  });
  registry.registerInstance('model_client', client);
  const agent = new Agent(client, toolManager, stream, { config }, undefined, permissions);
  registry.registerInstance('agent', agent);
  const runtime = RUNTIME_BEHAVIOR_CASES.includes(options.caseId as RuntimeBehaviorCaseId);
  const fixture = runtime ? undefined : getBehaviorFixture(options.caseId as BehaviorCaseId);
  let steeringPromise: Promise<unknown> | undefined;
  const observe = (event: ActivityEvent, owner: string) => {
    if (
      [ActivityEventType.TOOL_CALL_START, ActivityEventType.TOOL_CALL_END].includes(event.type) &&
      event.data?.toolName &&
      !event.data?.groupExecution
    ) {
      if (event.type === ActivityEventType.TOOL_CALL_START) toolArguments.set(event.id, event.data?.arguments);
      toolEvents.push({
        id: event.id,
        parentId: event.parentId,
        owner,
        type: event.type,
        data: { ...structuredClone(event.data), arguments: toolArguments.get(event.id) },
        timestamp: event.timestamp,
      });
      if (
        event.type === ActivityEventType.TOOL_CALL_END &&
        owner === 'main' &&
        fixture?.steering &&
        !steeringPromise &&
        toolEvents.filter(item => item.type === ActivityEventType.TOOL_CALL_END).length >=
          fixture.steering.afterToolCalls
      ) {
        steeringPromise = agent!
          .getSession()
          .submit(fixture.steering.message)
          .then(result => {
            steering = result;
          });
      }
    }
  };
  const observeStream = (target: ActivityStream) => {
    target.subscribe('*', event => observe(event, target === stream ? 'main' : 'delegate'));
    const scoped = target.createScoped.bind(target);
    target.createScoped = parentId => {
      const child = scoped(parentId);
      observeStream(child);
      return child;
    };
  };
  observeStream(stream);
  let stopDrain: Promise<void> | undefined;
  let stopCleanupFailed = false;
  const onStop = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== BEHAVIOR_WORKER_STOP || stopDrain) return;
    error = 'Campaign worker stop requested';
    // Admit foreground shell handles to the existing manager before interrupting
    // their foreground waits, so detached groups remain owned during shutdown.
    bash.backgroundForeground();
    if (process.connected) process.send?.({ type: BEHAVIOR_WORKER_STOPPING,
      ownedProcesses: bash.listProcesses().filter(info => info.status !== 'exited').map(info => ({id:info.id,pid:info.pid})),
    }, () => {});
    stopDrain = Promise.allSettled([agent!.stopAndDrain(), background.shutdown(), tasks.shutdown(), bash.shutdown(250)]).then(results => {
      for (const result of results) if (result.status === 'rejected') {
        stopCleanupFailed = true; error = `${error ?? ''} Stop cleanup failed: ${String(result.reason)}`;
      }
    });
    void writeResult().catch(() => {});
  };
  process.on('message', onStop);
  const checkpointTimer = setInterval(() => {
    void writeResult().catch(() => {});
  }, 5000);
  const taskPrompt = (prompt: string) =>
    `${prompt}\nExecution policy for this isolated fixture: shell commands are limited to node --test and npm test. Use file tools for inspection. Work only in the current workspace.`;
  try {
    if (runtime)
      await agent.sendMessage(
        taskPrompt(await setupRuntimeBehaviorFixture(options.caseId as RuntimeBehaviorCaseId, options.workspace))
      );
    else {
      await fixture!.setup(options.workspace);
      await agent.sendMessage(taskPrompt(fixture!.prompt));
    }
    if (steeringPromise) await steeringPromise;
    if (fixture?.steering)
      extraAssertions.push({
        name: 'steering-admitted-during-execution',
        passed: (steering as { kind?: string })?.kind === 'steered',
      });
    if (options.caseId === 'checkpoint-continuation') {
      const result = await agent.compactCurrentConversation({ trigger: 'manual', phase: 'manual' });
      extraAssertions.push({ name: 'checkpoint-committed', passed: !!result.checkpoint.id });
      const checkpoint = agent.getConversationManager().getCheckpoint();
      extraAssertions.push({
        name: 'original-direction-archived',
        passed: !!checkpoint?.semanticState.userDirections?.some(item => item.text.startsWith(CHECKPOINT_DIRECTION)),
      });
      if (!(await sessions.forceSave())) throw new Error('Checkpoint session did not persist');
      const reader = new SessionManager({ sessionsDir: join(data, 'sessions') });
      const saved = await reader.loadSession(sessions.getCurrentSession()!);
      extraAssertions.push({
        name: 'checkpoint-restored-from-disk',
        passed: saved?.conversation_checkpoint?.id === checkpoint?.id,
      });
      if (!saved?.conversation_checkpoint) throw new Error('Durable checkpoint is missing');
      agent.getSession().resume({
        messages: saved.messages,
        transcript: saved.transcript,
        checkpoint: saved.conversation_checkpoint,
        providerState: saved.provider_state,
      });
      await writeFile(join(options.workspace, 'settings.json'), '{"revision":2,"taxRate":0.125}\n');
      await agent.sendMessage(
        'settings.json changed externally after the checkpoint. Read its current contents. Create result.json with channel and currency from my original directions, and revision and taxRate from the current file. Do not change other files.'
      );
    }
    // Children execute asynchronously; drain their actual lifecycle before verification.
    await Promise.all(background.listTasks().map(task => task.promise));
    await agent.getSession().whenIdle();
    if (options.caseId === 'delegated-synthesis') {
      const fleet = background.listTasks();
      extraAssertions.push({
        name: 'one-real-successful-delegate',
        passed: fleet.length === 1 && fleet[0]?.status === 'done',
      });
      const parentReadNorth = toolEvents.some(
        event =>
          event.owner === 'main' &&
          event.type === ActivityEventType.TOOL_CALL_END &&
          event.data?.toolName === 'read' &&
          JSON.stringify(event.data?.arguments).includes('north.json')
      );
      extraAssertions.push({ name: 'parent-respected-work-division', passed: !parentReadNorth });
    }
    for (const name of fixture?.requiredTools ?? [])
      extraAssertions.push({
        name: `required-tool:${name}`,
        passed: toolEvents.some(
          event =>
            event.type === ActivityEventType.TOOL_CALL_END &&
            event.data?.toolName === name &&
            event.data?.result?.success
        ),
      });
    if (fixture) extraAssertions.push(...verifyFixtureReadRequirements(fixture, toolEvents.map(event => ({
      phase: event.type === ActivityEventType.TOOL_CALL_START ? 'start' as const : 'end' as const,
      owner: event.owner ?? 'unknown', toolName: event.data?.toolName,
      arguments: event.data?.arguments, success: event.data?.result?.success,
      errorType: event.data?.result?.error_type,
    })), options.workspace));
    if (fixture?.requiresTestRun) {
      extraAssertions.push({
        name: 'successful-visible-test-run',
        passed: toolEvents.some(
          event =>
            event.type === ActivityEventType.TOOL_CALL_END &&
            event.data?.toolName === 'bash' &&
            event.data?.result?.success &&
            event.data?.result?.return_code === 0
        ),
      });
    }
    if (options.promptVariant === 'outcome') {
      const taskRequests = requests.filter(request => request.owner === 'main' || request.owner === 'delegate');
      extraAssertions.push({
        name: 'candidate-applied-to-task-requests',
        passed: taskRequests.length > 0 && taskRequests.every(request => request.variantApplied),
      });
    }
    verification = runtime
      ? await verifyRuntimeBehaviorFixture(options.caseId as RuntimeBehaviorCaseId, options.workspace)
      : await fixture!.verify(options.workspace);
  } catch (failure) {
    error = failure instanceof Error ? failure.stack : String(failure);
  } finally {
    clearInterval(checkpointTimer);
    if (stopDrain) await stopDrain;
    let cleanupSucceeded = !stopCleanupFailed;
    frozenFleet = structuredClone(
      background.listTasks().map(task => ({
        id: task.id,
        status: task.status,
        error: task.error,
        result: task.result,
        messages: task.completedView?.messages,
      }))
    );
    frozenMessages = structuredClone(agent.getMessages());
    frozenTurn = structuredClone(agent.getTurnSnapshot());
    for (const cleanup of [
      () => background.shutdown(),
      () => messaging.cleanup(),
      () => tasks.shutdown(),
      () => bash.shutdown(),
      () => agent!.cleanup(),
      () => sessions.cleanup(),
      () => transport.drain(),
    ]) {
      try {
        await cleanup();
      } catch (failure) {
        cleanupSucceeded = false;
        error = `${error ?? ''} Cleanup failed: ${String(failure)}`;
      }
    }
    process.removeListener('message', onStop);
    if (stopDrain) await stopDrain;
    cleanupSucceeded &&= !stopCleanupFailed;
    transport.restore();
    await writeResult();
    if (cleanupSucceeded && process.connected && process.send) await new Promise<void>(resolve => {
      process.send!({ type: BEHAVIOR_WORKER_CLEANED }, () => resolve());
    });
    if (process.connected) process.disconnect();
    if (stopDrain) process.exitCode = 124;
  }
}
main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => { if (process.connected) process.disconnect(); });
