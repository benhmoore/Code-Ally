#!/usr/bin/env python3
"""
Conversation Monitor - Example Background Plugin with Event Subscription

This demonstrates how to create a background plugin that:
1. Runs as a persistent daemon alongside Ally
2. Subscribes to and receives read-only events from Ally
3. Maintains state across multiple tool invocations
4. Provides RPC methods for querying accumulated data

The plugin tracks conversation metrics (tool calls, agents, todos) and provides
statistics via JSON-RPC methods.
"""

import json
import socket
import os
import sys
import signal
import threading
from typing import Dict, Any
from datetime import datetime


class ConversationMonitor:
    """
    Tracks conversation metrics by listening to events from Ally.

    Maintains counters for:
    - Tool calls (total, successful, failed)
    - Agent invocations (main agent, subagents)
    - Todo list updates
    - Context usage (current percentage)
    """

    def __init__(self):
        self.stats = {
            'tool_calls_total': 0,
            'tool_calls_success': 0,
            'tool_calls_failed': 0,
            'agent_invocations': 0,
            'subagent_invocations': 0,
            'todo_updates': 0,
            'current_context_usage': 0,
            'session_start': datetime.now().isoformat(),
            'last_event': None,
            'tool_breakdown': {}  # Count per tool name
        }
        self.lock = threading.Lock()

    def handle_event(self, event_type: str, event_data: Dict[str, Any]) -> None:
        """Process an event from Ally and update statistics."""
        # Validate event_data is a dict
        if not isinstance(event_data, dict):
            print(
                f"[ConversationMonitor] Warning: Malformed event_data for {event_type}: "
                f"expected dict, got {type(event_data).__name__}",
                file=sys.stderr
            )
            return

        with self.lock:
            self.stats['last_event'] = {
                'type': event_type,
                'timestamp': event_data.get('timestamp', datetime.now().timestamp())
            }

            if event_type == 'TOOL_CALL_START':
                self.stats['tool_calls_total'] += 1
                # Track per-tool breakdown
                tool_name = event_data.get('toolName', 'unknown')
                if tool_name not in self.stats['tool_breakdown']:
                    self.stats['tool_breakdown'][tool_name] = 0
                self.stats['tool_breakdown'][tool_name] += 1

            elif event_type == 'TOOL_CALL_END':
                # Check if tool succeeded or failed
                result = event_data.get('result', {})
                if event_data.get('success', True) and not result.get('error'):
                    self.stats['tool_calls_success'] += 1
                else:
                    self.stats['tool_calls_failed'] += 1

            elif event_type == 'AGENT_START':
                # Distinguish between main agent and subagents
                if event_data.get('isSpecializedAgent', False):
                    self.stats['subagent_invocations'] += 1
                else:
                    self.stats['agent_invocations'] += 1

            elif event_type == 'TODO_UPDATE':
                self.stats['todo_updates'] += 1

            elif event_type == 'CONTEXT_USAGE_UPDATE':
                # Track current context usage percentage
                self.stats['current_context_usage'] = event_data.get('contextUsage', 0)

    def get_stats(self) -> Dict[str, Any]:
        """Return current statistics."""
        with self.lock:
            # Calculate derived metrics
            stats_copy = self.stats.copy()
            stats_copy['uptime_seconds'] = (
                datetime.now() - datetime.fromisoformat(self.stats['session_start'])
            ).total_seconds()

            # Add success rate
            total = self.stats['tool_calls_total']
            if total > 0:
                stats_copy['tool_success_rate'] = round(
                    (self.stats['tool_calls_success'] / total) * 100, 2
                )
            else:
                stats_copy['tool_success_rate'] = 0.0

            return stats_copy

    def reset_stats(self) -> Dict[str, Any]:
        """Reset all statistics."""
        with self.lock:
            old_stats = self.stats.copy()
            self.stats = {
                'tool_calls_total': 0,
                'tool_calls_success': 0,
                'tool_calls_failed': 0,
                'agent_invocations': 0,
                'subagent_invocations': 0,
                'todo_updates': 0,
                'current_context_usage': 0,
                'session_start': datetime.now().isoformat(),
                'last_event': None,
                'tool_breakdown': {}
            }
            return {'reset': True, 'previous_stats': old_stats}


class JSONRPCServer:
    """
    JSON-RPC 2.0 server that listens on a Unix domain socket.

    Handles:
    - JSON-RPC requests (with id) -> sends response
    - JSON-RPC notifications (no id) -> processes without response
    """

    def __init__(self, socket_path: str, monitor: ConversationMonitor):
        self.socket_path = socket_path
        self.monitor = monitor
        self.running = False
        self.server_socket = None

    def start(self):
        """Start the JSON-RPC server."""
        # Remove existing socket file if present
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

        # Create Unix domain socket
        self.server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server_socket.bind(self.socket_path)
        self.server_socket.listen(5)

        # Set socket timeout to allow periodic checking of self.running
        # This ensures clean shutdown when no new connections arrive
        self.server_socket.settimeout(1.0)

        # Set socket permissions (owner read/write only for security)
        os.chmod(self.socket_path, 0o600)

        self.running = True
        print(f"[ConversationMonitor] Listening on {self.socket_path}", file=sys.stderr)

        # Accept connections
        while self.running:
            try:
                try:
                    client_socket, _ = self.server_socket.accept()
                except socket.timeout:
                    # Timeout allows us to check self.running periodically
                    continue

                # Handle each client in a separate thread
                thread = threading.Thread(target=self.handle_client, args=(client_socket,))
                thread.daemon = True
                thread.start()
            except Exception as e:
                if self.running:  # Only log if not shutting down
                    print(f"[ConversationMonitor] Accept error: {e}", file=sys.stderr)

    def handle_client(self, client_socket: socket.socket):
        """Handle a client connection."""
        try:
            # Read data from client
            data = b''
            while True:
                chunk = client_socket.recv(4096)
                if not chunk:
                    break
                data += chunk

                # Try to parse JSON (check if we have complete message)
                try:
                    message = json.loads(data.decode('utf-8'))
                    break
                except json.JSONDecodeError:
                    # Incomplete message, keep reading
                    continue

            if not data:
                return

            # Process JSON-RPC message
            response = self.process_message(message)

            # Send response if this was a request (has id field)
            if response and 'id' in message:
                client_socket.sendall(json.dumps(response).encode('utf-8'))

        except Exception as e:
            print(f"[ConversationMonitor] Client handler error: {e}", file=sys.stderr)
        finally:
            client_socket.close()

    def process_message(self, message: Dict[str, Any]) -> Dict[str, Any] | None:
        """
        Process a JSON-RPC message.

        Returns response dict for requests, None for notifications.
        """
        # Validate JSON-RPC version
        if message.get('jsonrpc') != '2.0':
            return {
                'jsonrpc': '2.0',
                'error': {
                    'code': -32600,
                    'message': 'Invalid Request: jsonrpc must be "2.0"'
                },
                'id': message.get('id')
            }

        method = message.get('method')
        params = message.get('params', {})
        message_id = message.get('id')

        # Handle notifications (no response needed)
        if message_id is None:
            if method == 'on_event':
                event_type = params.get('event_type')
                event_data = params.get('event_data', {})
                self.monitor.handle_event(event_type, event_data)
            return None

        # Handle RPC methods
        try:
            if method == 'get_stats':
                result = self.monitor.get_stats()
                return {
                    'jsonrpc': '2.0',
                    'result': result,
                    'id': message_id
                }

            elif method == 'reset_stats':
                result = self.monitor.reset_stats()
                return {
                    'jsonrpc': '2.0',
                    'result': result,
                    'id': message_id
                }

            elif method == 'health_check':
                return {
                    'jsonrpc': '2.0',
                    'result': {'status': 'healthy'},
                    'id': message_id
                }

            else:
                return {
                    'jsonrpc': '2.0',
                    'error': {
                        'code': -32601,
                        'message': f'Method not found: {method}'
                    },
                    'id': message_id
                }

        except Exception as e:
            return {
                'jsonrpc': '2.0',
                'error': {
                    'code': -32603,
                    'message': f'Internal error: {str(e)}'
                },
                'id': message_id
            }

    def stop(self):
        """Stop the server."""
        self.running = False
        if self.server_socket:
            self.server_socket.close()
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)


def main():
    """Main entry point for the daemon."""
    # Get socket path from manifest (hardcoded for this example)
    socket_path = '/tmp/ally-conversation-monitor.sock'

    # Create monitor and server
    monitor = ConversationMonitor()
    server = JSONRPCServer(socket_path, monitor)

    # Signal handler for graceful shutdown
    def signal_handler(sig, frame):
        print("[ConversationMonitor] Shutting down...", file=sys.stderr)
        server.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    # Start server (blocks)
    try:
        server.start()
    except Exception as e:
        print(f"[ConversationMonitor] Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
