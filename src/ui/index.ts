/**
 * UI Module - Public exports for Code Ally UI system
 *
 * This module provides all the public-facing UI components, contexts, and hooks
 * needed to build and extend the Code Ally terminal interface.
 */

// Main App Component
export { App, AppWithMessages } from './App.js';
export type { AppProps, AppWithMessagesProps } from './App.js';

// Contexts
export { ActivityProvider, useActivityStreamContext } from './contexts/ActivityContext.js';
export type { ActivityProviderProps } from './contexts/ActivityContext.js';

export { AppProvider, useAppContext } from './contexts/AppContext.js';
export type {
  AppState,
  AppActions,
  AppContextValue,
  AppProviderProps,
} from './contexts/AppContext.js';

// Hooks
export { useActivityStream } from './hooks/useActivityStream.js';
export { useActivityEvent } from './hooks/useActivityEvent.js';
export { useToolState } from './hooks/useToolState.js';
export type { ToolState } from './hooks/useToolState.js';
export { useAnimation, useFrameAnimation } from './hooks/useAnimation.js';
export type { AnimationState, UseAnimationOptions } from './hooks/useAnimation.js';
