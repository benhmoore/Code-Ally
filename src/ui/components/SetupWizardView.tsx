/** Essential setup with cancellable discovery and an explicit review before saving. */
import React, { useEffect, useRef, useState } from 'react';
import { Text, useInput } from 'ink';
import { SetupWizard, type SetupConfig } from '@services/SetupWizard.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { ProviderModel } from '@llm/ProviderAdapter.js';
import { MODEL_PROVIDERS } from '@config/providers.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { truncateAnsiToWidth } from '@utils/terminalText.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';
import { ActivityEventType } from '@shared/index.js';

type Step =
  | 'provider'
  | 'endpoint'
  | 'credentials'
  | 'discovering'
  | 'discovery-error'
  | 'model'
  | 'manual'
  | 'checking'
  | 'unverified'
  | 'context'
  | 'review'
  | 'saving'
  | 'complete';
interface Props {
  onComplete: () => void;
  onSkip?: () => void;
}

export const SetupWizardView: React.FC<Props> = ({ onComplete, onSkip }) => {
  const [wizard] = useState(() => new SetupWizard(ServiceRegistry.getInstance().getRequired('config_manager')));
  const [initial] = useState(() => ServiceRegistry.getInstance().getRequired('config_manager').getConfig());
  const [providerIndex, setProviderIndex] = useState(() =>
    Math.max(
      0,
      MODEL_PROVIDERS.findIndex(provider => provider.value === initial.provider)
    )
  );
  const provider = MODEL_PROVIDERS[providerIndex]!;
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [apiKey, setApiKey] = useState(initial.api_key ?? '');
  const [model, setModel] = useState(initial.model ?? '');
  const [cursor, setCursor] = useState(initial.endpoint.length);
  const [step, setStep] = useState<Step>('provider');
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [contextOptions] = useState(() => wizard.getContextSizeOptions(initial.context_size));
  const [contextIndex, setContextIndex] = useState(() =>
    Math.max(
      0,
      contextOptions.findIndex(option => option.value === initial.context_size)
    )
  );
  const [choice, setChoice] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const saveInProgress = useRef(false);
  const persistedDraft = useRef<string | undefined>(undefined);
  const completed = useRef(false);
  const activated = useRef(false);
  const terminalRows = useTerminalRows();
  const contentWidth = Math.max(8, useContentWidth() - 4);
  const connectionProvider = useRef(initial.provider ?? 'ollama');
  const draft: SetupConfig = {
    provider: provider.value,
    endpoint: endpoint.trim(),
    api_key: apiKey.trim() || null,
    model: model.trim(),
    context_size: contextOptions[contextIndex]!.value,
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  const go = (next: Step) => {
    request.current?.abort();
    request.current = undefined;
    setStep(next);
    setChoice(0);
    setError('');
  };
  const complete = () => {
    if (!completed.current) {
      completed.current = true;
      onComplete();
    }
  };
  const back = () => {
    if (step === 'saving') return;
    if (step === 'complete') {
      complete();
      return;
    }
    if (step === 'provider') {
      onSkip?.();
      return;
    }
    if (step === 'endpoint') go('provider');
    else if (step === 'credentials') {
      setCursor(endpoint.length);
      go('endpoint');
    } else if (['discovering', 'discovery-error', 'model', 'manual'].includes(step)) {
      setCursor(endpoint.length);
      go('endpoint');
    } else if (['checking', 'unverified', 'context'].includes(step)) {
      go(models.length ? 'model' : 'manual');
      setCursor(model.length);
    } else go('context');
  };
  const discover = async () => {
    go('discovering');
    setModels([]);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await wizard.discoverModels(draft.endpoint, draft.provider, draft.api_key, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (result.error) {
        setError(result.error);
        setStep('discovery-error');
        return;
      }
      setModels(result.models);
      setModelIndex(
        Math.max(
          0,
          result.models.findIndex(item => item.name === model)
        )
      );
      if (!result.models.length) {
        setNotice(
          result.supported
            ? 'No models are installed. Enter a model name, or go back after installing one.'
            : 'Model listing is unavailable. Enter the exact model name.'
        );
        setCursor(model.length);
        setStep('manual');
      } else setStep('model');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : 'Connection failed');
      setStep('discovery-error');
    }
  };
  const checkModel = async (name: string) => {
    if (!name.trim()) {
      setError('Enter a model name.');
      return;
    }
    setModel(name.trim());
    go('checking');
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await wizard.inspectModel(
        { ...draft, model: name.trim() },
        models.find(item => item.name === name.trim()),
        controller.signal
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (result.tools === 'unsupported') {
        setError(`${name} does not support tools. Choose another model.`);
        setStep(models.length ? 'model' : 'manual');
        setCursor(name.length);
        return;
      }
      setNotice(result.note ?? '');
      setStep(result.tools === 'unknown' ? 'unverified' : 'context');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setNotice(failure instanceof Error ? failure.message : 'Tool support could not be verified.');
      setStep('unverified');
    }
  };
  const save = async () => {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    go('saving');
    try {
      const registry = ServiceRegistry.getInstance();
      const block =
        registry.get('agent')?.getModelIdentityChangeBlock(draft) ??
        registry.get('agent_pool')?.getModelIdentityChangeBlock(draft);
      if (block) throw new Error(block);
      const identity = JSON.stringify(draft);
      if (persistedDraft.current !== identity) {
        await wizard.applySetupConfig(draft);
        persistedDraft.current = identity;
      }
      const committed = registry.getRequired('config_manager').getConfig();
      const applied = applyRuntimeConfigUpdates(registry, committed);
      if (!applied) throw new Error('Runtime configuration is unavailable.');
      registry.get('activity_stream')?.emit({
        id: `setup_config_${Date.now()}`,
        type: ActivityEventType.CONFIG_UPDATED,
        timestamp: Date.now(),
        data: committed,
      });
      activated.current = true;
      if (mounted.current) setStep('complete');
    } catch (failure) {
      if (mounted.current) {
        const state =
          persistedDraft.current === JSON.stringify(draft)
            ? 'Settings saved, but activation failed'
            : 'Settings were not saved';
        setError(`${state}: ${failure instanceof Error ? failure.message : String(failure)}`);
        setStep('review');
      }
    } finally {
      saveInProgress.current = false;
    }
  };
  const cancel = () => {
    if (saveInProgress.current) return;
    if (step === 'complete') {
      complete();
      return;
    }
    request.current?.abort();
    onSkip?.();
  };
  const textStep = step === 'endpoint' || step === 'credentials' || step === 'manual';
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (activated.current) {
      if (key.return || key.escape || (key.ctrl && input === 'c')) complete();
      return;
    }
    if (key.ctrl && input === 'c' && !textStep) {
      cancel();
      return;
    }
    if (key.escape && !textStep) {
      back();
      return;
    }
    if (textStep || step === 'saving') return;
    const move = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value + (key.upArrow ? -1 : 1)));
    if (step === 'provider') {
      if (key.upArrow || key.downArrow) setProviderIndex(index => move(index, MODEL_PROVIDERS.length - 1));
      if (key.return) {
        if (connectionProvider.current !== provider.value) {
          const same = provider.value === initial.provider;
          const value = same ? initial.endpoint : provider.endpoint;
          setEndpoint(value);
          setApiKey(same ? (initial.api_key ?? '') : '');
          setCursor(value.length);
          connectionProvider.current = provider.value;
        } else setCursor(endpoint.length);
        go('endpoint');
      }
    } else if (step === 'model') {
      if (key.upArrow || key.downArrow) setModelIndex(index => move(index, models.length));
      if (key.return) {
        if (modelIndex === models.length) {
          setCursor(model.length);
          go('manual');
        } else void checkModel(models[modelIndex]!.name);
      }
    } else if (step === 'context') {
      if (key.upArrow || key.downArrow) setContextIndex(index => move(index, contextOptions.length - 1));
      if (key.return) go('review');
    } else if (step === 'discovery-error' || step === 'unverified') {
      if (key.upArrow || key.downArrow) setChoice(index => move(index, 2));
      if (key.return) {
        if (choice === 0) {
          if (step === 'discovery-error') void discover();
          else void checkModel(model);
        } else if (choice === 1) back();
        else if (step === 'unverified') go('context');
        else {
          setCursor(model.length);
          go('manual');
        }
      }
    } else if (step === 'review' && key.return) void save();
    else if (step === 'complete' && key.return) complete();
  });

  const submitText = (value: string) => {
    if (step === 'endpoint') {
      try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setError('Enter a complete http:// or https:// endpoint.');
        return;
      }
      setEndpoint(value.trim());
      setCursor(apiKey.length);
      go('credentials');
    } else if (step === 'credentials') void discover();
    else void checkModel(value);
  };
  const titles: Record<Step, string> = {
    provider: '1 / 5 · Model provider',
    endpoint: '2 / 5 · Server endpoint',
    credentials: '2 / 5 · API key',
    discovering: 'Connecting…',
    'discovery-error': 'Connection needs attention',
    model: '3 / 5 · Model',
    manual: '3 / 5 · Model name',
    checking: 'Checking tool support…',
    unverified: 'Tool support is unverified',
    context: '4 / 5 · Context window',
    review: '5 / 5 · Review settings',
    saving: 'Saving settings…',
    complete: 'Ready to code',
  };
  const options =
    step === 'discovery-error'
      ? ['Retry connection', 'Edit endpoint', 'Enter model manually']
      : ['Retry check', 'Choose another model', 'Continue with this model'];
  const textValue = step === 'endpoint' ? endpoint : step === 'credentials' ? apiKey : model;
  const modelRows = Math.max(1, Math.min(12, terminalRows - 9));
  const modelWindowStart = Math.max(0, Math.min(modelIndex - Math.floor(modelRows / 2), models.length - modelRows));
  const hints =
    step === 'saving'
      ? []
      : step === 'complete'
        ? [{ key: 'enter', label: 'start' }]
        : step === 'discovering' || step === 'checking'
          ? [
              { key: 'esc', label: 'stop check' },
              { key: 'ctrl+c', label: 'leave' },
            ]
          : [
              { key: 'enter', label: step === 'review' ? (error ? 'retry save' : 'save') : 'continue' },
              { key: 'esc', label: 'back' },
              { key: 'ctrl+c', label: 'leave' },
            ];
  return (
    <InteractiveSurface
      title="Setup"
      meta={titles[step]}
      footer={
        step === 'saving' ? <Text dimColor>Saving your configuration</Text> : <KeyboardHintFooter hints={hints} />
      }
    >
      {step === 'provider' && (
        <>
          <Text dimColor>Connect your model server.</Text>
          {MODEL_PROVIDERS.map((item, index) => (
            <SelectionIndicator key={item.value} isSelected={index === providerIndex}>
              {item.label}
            </SelectionIndicator>
          ))}
        </>
      )}
      {error && (
        <Text color={UI_COLORS.ERROR} wrap="truncate-end">
          {error}
        </Text>
      )}
      {textStep && (
        <>
          <Text dimColor>
            {step === 'endpoint'
              ? 'Use the base URL of your model server.'
              : step === 'credentials'
                ? 'Leave empty for a local server that does not require authentication.'
                : notice || 'Enter the exact model name served by this endpoint.'}
          </Text>
          <TextInput
            key={step}
            value={textValue}
            onValueChange={step === 'endpoint' ? setEndpoint : step === 'credentials' ? setApiKey : setModel}
            cursorPosition={cursor}
            onCursorChange={setCursor}
            onSubmit={submitText}
            onEscape={back}
            onCtrlC={cancel}
            onKeyPressCapture={(input, key) => {
              if (key.ctrl && input === 'c') {
                cancel();
                return true;
              }
              return false;
            }}
            mask={step === 'credentials' ? '*' : undefined}
            multiline={false}
            maxVisibleRows={1}
          />
        </>
      )}
      {step === 'discovering' && <Text wrap="truncate-end">Listing models at {draft.endpoint}</Text>}
      {step === 'checking' && (
        <>
          <Text wrap="truncate-end">Reading capabilities for {model}</Text>
          <Text dimColor>No response generation is needed.</Text>
        </>
      )}
      {step === 'model' && (
        <>
          {models.slice(modelWindowStart, modelWindowStart + modelRows).map((item, index) => (
            <SelectionIndicator key={item.name} isSelected={index + modelWindowStart === modelIndex}>
              {truncateAnsiToWidth(item.name, contentWidth)}
            </SelectionIndicator>
          ))}
          <SelectionIndicator isSelected={modelIndex === models.length}>Enter another model name</SelectionIndicator>
          {models.length > modelRows && (
            <Text dimColor>
              {Math.min(modelIndex + 1, models.length)} / {models.length} models · ↑↓ to browse
            </Text>
          )}
        </>
      )}
      {(step === 'discovery-error' || step === 'unverified') && (
        <>
          {step === 'unverified' && <Text wrap="truncate-end">{notice}</Text>}
          {options.map((item, index) => (
            <SelectionIndicator key={item} isSelected={index === choice}>
              {item}
            </SelectionIndicator>
          ))}
        </>
      )}
      {step === 'context' && (
        <>
          <Text dimColor>Larger windows use more memory. Match your server setting.</Text>
          {contextOptions.map((item, index) => (
            <SelectionIndicator key={item.value} isSelected={index === contextIndex}>
              {item.label}
            </SelectionIndicator>
          ))}
        </>
      )}
      {step === 'review' && (
        <>
          <Text wrap="truncate-end">
            {provider.label} · {draft.endpoint}
          </Text>
          <Text wrap="truncate-end">Model: {model}</Text>
          <Text>Context: {draft.context_size.toLocaleString()} tokens</Text>
          <Text>API key: {apiKey ? 'configured (hidden)' : 'not required'}</Text>
          <Text dimColor wrap="truncate-end">
            Other saved preferences stay unchanged.
          </Text>
          {provider.value !== initial.provider && initial.service_model && (
            <Text dimColor>The auxiliary model will follow this model after changing providers.</Text>
          )}
          {notice && (
            <Text dimColor wrap="truncate-end">
              {notice}
            </Text>
          )}
        </>
      )}
      {step === 'complete' && (
        <>
          <Text color={UI_COLORS.PRIMARY}>Settings saved.</Text>
          <Text dimColor>
            Change settings with /config. Add search with /config set search_provider=… and connect tools with /mcp add.
          </Text>
        </>
      )}
    </InteractiveSurface>
  );
};
