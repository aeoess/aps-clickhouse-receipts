// The pitch video is itself an agent run. This dispatcher registers
// agent:pitch-presenter and issues a receipt-gated dispatch for every
// pipeline step of the video build: receipt first, then the step runs.
// One dispatch (publish_video) is deliberately outside the delegated
// scope: it is denied live, receipted, and never executed.
import { createPrincipalIdentity } from 'agent-passport-system';
import {
  registerControlPlaneAgent,
  receiptForAction,
  verifyTrail,
  closeAdapterClient,
} from '../src/controlplane-adapter.js';

const SCOPE = ['query_receipts', 'render_visual', 'synthesize_voice', 'compose_video'];

const STEPS: Array<{ tool: string; note: string }> = [
  { tool: 'synthesize_voice', note: 'lane A: narration, one MP3 per beat (9 beats)' },
  { tool: 'render_visual', note: 'lane B: terminal frames, ASCII face beats 1 and 9, captures' },
  { tool: 'query_receipts', note: 'pull agent:pitch-presenter rows live for the beat 9 screen' },
  { tool: 'compose_video', note: 'assembly: segments, mux at beat offsets, loudnorm, encode' },
  { tool: 'publish_video', note: 'deliberate out-of-scope dispatch: publishing was never delegated' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const principal = createPrincipalIdentity({ displayName: 'Tymofii Pidlisnyi', domain: 'agent-passport.org' });
  const agent = registerControlPlaneAgent('pitch-presenter', principal, SCOPE);
  console.log(`registered ${agent.agentId} scope=${SCOPE.join(',')}`);

  for (const step of STEPS) {
    await sleep(1100); // second-precision action_ref spacing
    const r = await receiptForAction({
      agent,
      tool: step.tool,
      args: { note: step.note },
      scope_check: step.tool,
    });
    console.log(`dispatch ${step.tool.padEnd(16)} decision=${r.decision.padEnd(6)} receipt=${r.receiptId}`);
    if (r.decision === 'deny') {
      console.log(`         ${step.tool} did not execute (no delegated authority)`);
    }
  }

  const trail = await verifyTrail(agent.agentId);
  console.log(`verifyTrail ${agent.agentId}: ${trail.passed}/${trail.total} rows PASS (ok=${trail.ok})`);

  await closeAdapterClient();
}

main().catch((e) => { console.error('dispatch failed:', e.message); process.exit(1); });
