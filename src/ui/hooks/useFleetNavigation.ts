import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '@agent/Agent.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { AppActions } from '../contexts/AppContext.js';
import { useBackgroundAgents } from './useBackgroundAgents.js';
import { frozenConversation } from './useConversationSelector.js';

interface FleetNavigationOptions {
  activeAgentId: string;
  primaryAgent: Agent;
  foregroundAgent: Agent;
  foregroundAgentId: string;
  selectForegroundConversation: (agent: Agent, id: string) => void;
  returnToPrimaryConversation: () => void;
  actions: Pick<AppActions, 'setActiveAgentId' | 'repaintConversationSurface'>;
}

/** Own fleet focus, navigation and the selected conversation's isolated source. */
export function useFleetNavigation(options: FleetNavigationOptions) {
  const {
    activeAgentId,
    primaryAgent,
    foregroundAgent,
    foregroundAgentId,
    selectForegroundConversation,
    returnToPrimaryConversation,
    actions,
  } = options;
  const backgroundAgents = useBackgroundAgents();
  const selectedTask = backgroundAgents.find(task => task.id === activeAgentId);
  const isChildSelected = activeAgentId !== 'main';
  const completedChild = !!selectedTask && selectedTask.status !== 'running';
  const [fleetFocused, setFleetFocused] = useState(false);
  const [fleetSelectedIndex, setFleetSelectedIndex] = useState(0);
  const conversationSource = useMemo(() => {
    if (!isChildSelected) return primaryAgent.getSession();
    if (completedChild) return frozenConversation(selectedTask?.completedView);
    return foregroundAgentId === activeAgentId ? foregroundAgent.getSession() : frozenConversation();
  }, [
    isChildSelected,
    primaryAgent,
    completedChild,
    selectedTask?.completedView,
    foregroundAgentId,
    activeAgentId,
    foregroundAgent,
  ]);
  // Frozen completed views are observable but have no live mutation owner.
  const conversationControls = !isChildSelected
    ? primaryAgent.getSession()
    : !completedChild && selectedTask?.status === 'running' && foregroundAgentId === activeAgentId
      ? foregroundAgent.getSession()
      : undefined;
  const previousView = useRef(activeAgentId);
  useEffect(() => {
    if (previousView.current === activeAgentId) return;
    previousView.current = activeAgentId;
    actions.repaintConversationSurface();
  }, [activeAgentId, actions]);
  const returnToMain = useCallback(() => {
    returnToPrimaryConversation();
    actions.setActiveAgentId('main');
  }, [returnToPrimaryConversation, actions]);
  const handleEnterFleet = useCallback(() => {
    setFleetSelectedIndex(0);
    setFleetFocused(true);
  }, []);
  const handleFleetNavigate = useCallback((index: number) => {
    setFleetSelectedIndex(index);
  }, []);
  const handleExitFleet = useCallback(() => {
    setFleetFocused(false);
  }, []);
  const handleEnterAgent = useCallback(
    (index: number) => {
      if (index === 0) {
        if (isChildSelected) returnToMain();
        return;
      }
      const target = backgroundAgents[index - 1];
      if (!target) return;
      selectForegroundConversation(target.subAgent, target.id);
      actions.setActiveAgentId(target.id);
    },
    [backgroundAgents, isChildSelected, returnToMain, selectForegroundConversation, actions]
  );
  const [backgroundStatus, setBackgroundStatus] = useState<string>();
  const handleBackgroundCommand = useCallback(() => {
    if (completedChild || (isChildSelected && foregroundAgentId !== activeAgentId)) {
      setBackgroundStatus('No running foreground command.');
      return;
    }
    const owner = isChildSelected ? foregroundAgent : primaryAgent;
    const count = ServiceRegistry.getInstance().get('bash_process_manager')?.backgroundForeground(owner.getInstanceId()) ?? 0;
    setBackgroundStatus(count > 0 ? `Backgrounded ${count} command${count === 1 ? '' : 's'}.` : 'No running foreground command.');
  }, [completedChild, isChildSelected, foregroundAgentId, activeAgentId, foregroundAgent, primaryAgent]);
  const handleKillAgent = useCallback(
    (index: number) => {
      const target = index > 0 ? backgroundAgents[index - 1] : undefined;
      if (!target) return;
      ServiceRegistry.getInstance().get('background_agent_manager')?.cancelTask(target.id);
      if (activeAgentId === target.id) returnToMain();
    },
    [backgroundAgents, activeAgentId, returnToMain]
  );
  useEffect(() => {
    setFleetSelectedIndex(index => Math.min(index, backgroundAgents.length));
    if (!backgroundAgents.length) setFleetFocused(false);
    if (isChildSelected && !selectedTask) returnToMain();
  }, [backgroundAgents.length, isChildSelected, selectedTask, returnToMain]);
  return {
    backgroundAgents,
    selectedTask,
    isChildSelected,
    completedChild,
    conversationSource,
    conversationControls,
    fleetFocused,
    fleetSelectedIndex,
    backgroundStatus,
    returnToMain,
    handleEnterFleet,
    handleFleetNavigate,
    handleExitFleet,
    handleEnterAgent,
    handleBackgroundCommand,
    handleKillAgent,
  };
}
