/**
 * Verification script to ensure all exports are working correctly
 */

import { ToolManager, ToolValidator, BashTool, ReadTool } from './index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';

console.log('✓ All imports successful');

// Verify classes are constructable
const activityStream = new ActivityStream();
const bashTool = new BashTool(activityStream);
const readTool = new ReadTool(activityStream);
const toolManager = new ToolManager([bashTool, readTool], activityStream);
new ToolValidator();

console.log('✓ All classes instantiated');

// Verify basic properties
console.log(`✓ BashTool name: ${bashTool.name}`);
console.log(`✓ ReadTool name: ${readTool.name}`);
console.log(`✓ ToolManager has ${toolManager.getAllTools().length} tools`);

// Verify function definitions
const defs = toolManager.getFunctionDefinitions();
console.log(`✓ Generated ${defs.length} function definitions`);

// Verify event types
console.log(`✓ ActivityEventType.TOOL_CALL_START: ${ActivityEventType.TOOL_CALL_START}`);

console.log('\n✅ All verifications passed!');
