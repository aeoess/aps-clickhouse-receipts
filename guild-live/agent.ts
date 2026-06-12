// Scaffolded with Guild CLI (guild agent init --template LLM), then wired
// so the tool map, the scaffold's dispatch point, routes every call through
// the receipt gate in dispatch.ts. A signed APS receipt lands in ClickHouse
// before any tool code runs; out-of-scope calls are denied and never execute.
//
// Note: the hosted Guild runtime cannot reach this repo's local ClickHouse
// store, so the live run drives this same tool surface locally via
// run-local.ts with the model behind `guild chat` (Guild managed tokens).

import { llmAgent } from "@guildai/agents-sdk";
import { tool } from "ai";
import { z } from "zod";
import { guardedDispatch, registerLiveAgent } from "./dispatch.js";

const agentIdentity = registerLiveAgent();

const systemPrompt: string = `
You summarize local text files. Read the requested files with read_file,
write one combined summary with write_summary, and use delete_file only when
the task asks for cleanup. Every tool call is checked against your delegated
scope and receipted; a denied call did not run, so report the denial and move on.
`;

const description = `
Reads short text files from sample-data and writes a combined summary file.
Every tool call is receipted to a ClickHouse audit trail before execution.
`;

export default llmAgent({
  description,
  tools: {
    read_file: tool({
      description: "Read a text file from sample-data by filename.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => (await guardedDispatch(agentIdentity, "read_file", { path })).output,
    }),
    write_summary: tool({
      description: "Write sample-data/summary.md with the given markdown content.",
      inputSchema: z.object({ content: z.string() }),
      execute: async ({ content }) =>
        (await guardedDispatch(agentIdentity, "write_summary", { content })).output,
    }),
    delete_file: tool({
      description: "Delete a file from sample-data by filename.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => (await guardedDispatch(agentIdentity, "delete_file", { path })).output,
    }),
  },
  systemPrompt,
});
