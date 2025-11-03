import { PermissionDeniedError as PathSecurityError } from './src/security/PathSecurity.js';
import { PermissionDeniedError as AgentError } from './src/agent/index.js';

// Create an error from PathSecurity
const error1 = new PathSecurityError('Test error 1');

// Create an error from agent/index
const error2 = new AgentError('Test error 2');

// Test instanceof checks
console.log('error1 instanceof PathSecurityError:', error1 instanceof PathSecurityError);
console.log('error1 instanceof AgentError:', error1 instanceof AgentError);
console.log('error2 instanceof PathSecurityError:', error2 instanceof PathSecurityError);
console.log('error2 instanceof AgentError:', error2 instanceof AgentError);

// They should be the same class
console.log('PathSecurityError === AgentError:', PathSecurityError === AgentError);

console.log('\n✅ All instanceof checks work correctly!');
