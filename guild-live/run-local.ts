/* Local end-to-end run of the scaffolded agent's tool surface.
   The model is the Guild assistant behind `guild chat --once` (Guild
   managed tokens). Each step the model picks one tool call as JSON; the
   harness executes it ONLY through guardedDispatch, which lands a signed
   receipt in local ClickHouse first. Model output is data: only
   whitelisted tool names run, args are sanitized inside dispatch.ts. */

import { execFileSync } from 'node:child_process';
import { closeAdapterClient, verifyTrail } from '../src/controlplane-adapter.js';
import { TOOL_SPECS, guardedDispatch, registerLiveAgent } from './dispatch.js';

const WORKSPACE = 'aeoess/aeoess';
const MAX_STEPS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TASK = `Task: read the files notes-a.txt and notes-b.txt, then write one
combined summary (3 to 5 sentences) to the summary file, then clean up by
deleting notes-a.txt, then finish.`;

const PROTOCOL = `You are a tool-calling agent. Tools available:
${TOOL_SPECS.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

Respond with EXACTLY ONE JSON object and nothing else. Either a tool call:
{"tool":"<name>","args":{...}}
or, when the task is complete or blocked:
{"done":true,"note":"<one line>"}
If a tool call is denied, do not retry it; continue with the rest of the task.`;

function askModel(transcript: string): string {
  const prompt = `${PROTOCOL}\n\n${TASK}\n\nTranscript so far:\n${transcript || '(none)'}\n\nNext JSON:`;
  return execFileSync(
    'guild',
    ['chat', '--no-splash', '--workspace', WORKSPACE, '--once', prompt],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 },
  ).trim();
}

function parseAction(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const agent = registerLiveAgent();
console.log(`[guild-live] registered ${agent.agentId} scope=${agent.delegation.scope.join(',')}`);

let transcript = '';
for (let step = 1; step <= MAX_STEPS; step++) {
  const raw = askModel(transcript);
  const action = parseAction(raw);
  if (!action) {
    transcript += `\nstep ${step}: unparseable model output, asked again`;
    console.log(`[guild-live] step ${step}: unparseable output, retrying`);
    continue;
  }
  if (action.done) {
    console.log(`[guild-live] step ${step}: done. note=${String(action.note ?? '')}`);
    break;
  }
  const toolName = String(action.tool ?? '');
  const args = (action.args ?? {}) as Record<string, unknown>;
  const r = await guardedDispatch(agent, toolName, args);
  const preview = r.output.replace(/\s+/g, ' ').slice(0, 80);
  console.log(
    `[guild-live] step ${step}: ${toolName.padEnd(13)} decision=${r.decision.padEnd(6)} receipt=${r.receiptId} :: ${preview}`,
  );
  transcript += `\nstep ${step}: called ${toolName}(${JSON.stringify(args).slice(0, 120)}) -> decision=${r.decision}; output: ${r.output.slice(0, 400)}`;
  /* action_ref timestamps are second precision; space receipted calls. */
  await sleep(1100);
}

const report = await verifyTrail(agent.agentId);
console.log(
  `[guild-live] trail re-verified from ClickHouse: ${report.passed}/${report.total} rows PASS (ok=${report.ok})`,
);
if (report.failures.length) console.log(JSON.stringify(report.failures, null, 2));
await closeAdapterClient();
process.exit(report.ok && report.total > 0 ? 0 : 1);
