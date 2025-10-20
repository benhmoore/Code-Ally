#!/usr/bin/env node
/**
 * Code Ally CLI Entry Point
 *
 * Initializes services and launches the Ink UI.
 */

import React from 'react';
import { render } from 'ink';
import { ServiceRegistry } from './services/ServiceRegistry.js';
import { ConfigManager } from './services/ConfigManager.js';
import { ActivityStream } from './services/ActivityStream.js';
import { App } from './ui/App.js';

async function main() {
  // Initialize service registry
  const registry = ServiceRegistry.getInstance();

  // Register config manager
  const configManager = new ConfigManager();
  await configManager.initialize();
  registry.registerInstance('config_manager', configManager);

  const config = configManager.getConfig();

  // Create activity stream
  const activityStream = new ActivityStream();
  registry.registerInstance('activity_stream', activityStream);

  // Render the Ink UI
  const { waitUntilExit } = render(
    React.createElement(App, {
      config,
      activityStream,
    })
  );

  // Wait for the app to exit
  await waitUntilExit();

  // Cleanup
  await registry.shutdown();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
