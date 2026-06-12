/* Receipt-gated tool dispatch for the scaffolded Guild agent.
   Single dispatch point: every tool call goes through receiptForAction
   against the local ClickHouse store BEFORE any tool code runs. Permit
   proceeds, deny returns without executing the tool. The agent is
   registered with a scope narrower than its tool surface on purpose, so
   one task step produces a live deny row. */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createPrincipalIdentity } from 'agent-passport-system';
import {
  type ControlPlaneAgent,
  receiptForAction,
  registerControlPlaneAgent,
} from '../src/controlplane-adapter.js';

const SAMPLE_DIR = resolve(import.meta.dirname, 'sample-data');

/* Tool surface the agent sees. delete_file is intentionally NOT in the
   delegated scope below. */
export const TOOL_SPECS = [
  {
    name: 'read_file',
    description: 'Read a text file from sample-data. Args: {"path": "<filename>"}',
  },
  {
    name: 'write_summary',
    description: 'Write the summary file sample-data/summary.md. Args: {"content": "<markdown>"}',
  },
  {
    name: 'delete_file',
    description: 'Delete a file from sample-data. Args: {"path": "<filename>"}',
  },
] as const;

export const DELEGATED_SCOPE = ['read_file', 'write_summary'];

export function registerLiveAgent(): ControlPlaneAgent {
  const principal = createPrincipalIdentity({
    displayName: 'Guild Live Demo Principal',
    domain: 'example.com',
  });
  return registerControlPlaneAgent('guild-live-summarizer', principal, DELEGATED_SCOPE);
}

/* Filenames only; resolves inside sample-data and rejects traversal. */
function samplePath(p: string): string {
  const full = resolve(join(SAMPLE_DIR, basename(String(p))));
  if (!full.startsWith(SAMPLE_DIR + '/')) throw new Error(`path escapes sample-data: ${p}`);
  return full;
}

const IMPL: Record<string, (args: Record<string, unknown>) => string> = {
  read_file: (args) => readFileSync(samplePath(String(args.path)), 'utf8'),
  write_summary: (args) => {
    writeFileSync(join(SAMPLE_DIR, 'summary.md'), String(args.content));
    return 'wrote sample-data/summary.md';
  },
  delete_file: (args) => {
    unlinkSync(samplePath(String(args.path)));
    return `deleted ${args.path}`;
  },
};

export interface DispatchResult {
  decision: string;
  receiptId: string;
  output: string;
}

export async function guardedDispatch(
  agent: ControlPlaneAgent,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  if (!(toolName in IMPL)) {
    return { decision: 'rejected', receiptId: 'n/a', output: `unknown tool: ${toolName}` };
  }
  const target =
    toolName === 'write_summary' ? 'file:summary.md' : `file:${basename(String(args.path ?? toolName))}`;
  const r = await receiptForAction({
    agent,
    tool: toolName,
    args: { ...args, target },
    scope_check: toolName,
  });
  if (r.decision !== 'permit') {
    return {
      decision: r.decision,
      receiptId: r.receiptId,
      output: `DENIED: ${toolName} is outside the delegated scope [${DELEGATED_SCOPE.join(', ')}]. The tool did not execute.`,
    };
  }
  return { decision: r.decision, receiptId: r.receiptId, output: IMPL[toolName](args) };
}
