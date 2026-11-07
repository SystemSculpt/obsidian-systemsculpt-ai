import { isRecord } from '../../utils/jsonRecord';
import { encodeSystemSculptToolResult, SYSTEMSCULPT_TOOL_SERVER, type SystemSculptToolset } from '../../tools/systemsculpt/SystemSculptTools';

/**
 * SystemSculpt tools reach Claude Code as an in-process tool server over the
 * same stdio control channel as permission prompts: no port, no extra process.
 * Claude Code calls each tool `mcp__systemsculpt__<name>` and still asks its
 * own permission question unless the launch allows the server.
 */
export function claudeToolBridgeArgs(permissionMode: string | undefined): string[] {
  const config = JSON.stringify({ mcpServers: { [SYSTEMSCULPT_TOOL_SERVER]: { type: 'sdk', name: SYSTEMSCULPT_TOOL_SERVER } } });
  // Plan only keeps every action behind Claude Code's question; other modes run SystemSculpt tools directly.
  return ['--mcp-config', config, ...(permissionMode === 'plan' ? [] : ['--allowedTools', `mcp__${SYSTEMSCULPT_TOOL_SERVER}`])];
}

/** Sent once per process before the first message so Claude Code connects the tool server. */
export function claudeToolBridgeInitialize(requestId: string): Record<string, unknown> {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize', sdkMcpServers: [SYSTEMSCULPT_TOOL_SERVER] } };
}

export function isClaudeToolBridgeMessage(request: Record<string, unknown>): boolean {
  return request.subtype === 'mcp_message' && request.server_name === SYSTEMSCULPT_TOOL_SERVER && isRecord(request.message);
}

/** One JSON-RPC answer for the tool server. Calls never reject; failures are tool errors. */
export async function answerClaudeToolBridgeMessage(tools: SystemSculptToolset, message: Record<string, unknown>, version: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const id = message.id;
  // Notifications get the acknowledgement Claude Code expects; they carry no id.
  if (id === undefined || id === null) return { jsonrpc: '2.0', result: {}, id: 0 };
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SYSTEMSCULPT_TOOL_SERVER, version },
        instructions: 'SystemSculpt tools: generate images and videos into the vault (shown inline in the chat) and list, create, open, edit and run SystemSculpt Studio workflows.',
      } };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.definitions.map(tool => ({
        name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: !tool.name.startsWith('studio_') },
      })) } };
    case 'tools/call': {
      const result = await tools.call(String(params.name ?? ''), params.arguments ?? {}, signal);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: encodeSystemSculptToolResult(result) }], ...(result.ok || result.link ? {} : { isError: true }) } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method).slice(0, 80)}` } };
  }
}
