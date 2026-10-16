/**
 * plugin/sub-human/mcp/types.ts: the shared types of mcp/*.ts (type-only; nothing here runs): the hand-rolled
 * JSON-RPC 2.0 messages, the MCP tool definitions and results this server speaks, and the room-server plug-in
 * contract (room-server.ts header).
 */

import type * as identityMod from '../lib/identity.ts';
import type { Identity } from '../lib/identity.ts';
import type * as roomMod from '../lib/room.ts';
import type * as proposalMod from '../lib/proposal.ts';

// ---------- JSON-RPC 2.0 ----------

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number | string;
  message: string;
  data?: unknown;
}

/** A line from the client, parsed but not validated yet: handle() narrows each field before it trusts it. */
export interface JsonRpcIncoming {
  jsonrpc?: unknown;
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** What this server writes: a response, a request of its own (ctx.request) or a notification. */
export type JsonRpcOutgoing =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError }
  | { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: '2.0'; method: string; params?: unknown };

// ---------- MCP ----------

export type ProgressToken = string | number;

/** The JSON Schema subset the tools' inputSchema uses. */
export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: JsonSchema;
  minimum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One entry of tools/list. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

/** A tools/call result: text content, isError when the tool refused. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

/** tools/call params (unvalidated: the client's). */
export interface CallToolParams {
  name?: string;
  arguments?: ToolArgs;
  _meta?: { progressToken?: ProgressToken };
}

/** A tool's arguments as the client sent them (each tool checks its own). */
export type ToolArgs = Record<string, unknown>;

/** meta = {id, progressToken} of a tools/call, for a plug-in that streams progress or watches for cancel. */
export interface CallMeta {
  id?: JsonRpcId;
  progressToken?: ProgressToken | undefined;
}

// ---------- the plug-in contract ----------

/** The calling member: identity.resolveByPid(process.ppid). */
export type Me = Identity;

/** ctx.request(method, params): a Promise of the client's result, with .id = the JSON-RPC request id. */
export type OutgoingRequest = Promise<unknown> & { id?: string };

/** ctx, shared by every plug-in (room-server.ts header). */
export interface PluginContext {
  send(msg: JsonRpcOutgoing): void;
  notify(method: string, params?: unknown): void;
  request(method: string, params?: unknown): OutgoingRequest;
  cancelRequest(id: string, reason?: string): void;
  progress(progressToken: ProgressToken | null | undefined, progress: number, message?: string): void;
  onCancel(requestId: JsonRpcId, fn: (reason?: unknown) => void): void;
  whoami(): Me | null;
  clientCaps(): Record<string, unknown>;
  room: typeof roomMod;
  identity: typeof identityMod;
  proposal: typeof proposalMod;
  text(s: unknown, isError?: boolean): ToolResult;
  log(...a: unknown[]): void;
}

/** create(ctx) -> {tools, call, stop?, anonymous?}: call returns a result, a Promise of one, or null (not its tool). */
export interface PluginApi {
  tools: ToolDefinition[];
  call(name: string, me: Me | null, args: ToolArgs, meta: CallMeta): ToolResult | Promise<ToolResult> | null;
  stop?(): void;
  anonymous?: string[];
}
