import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@summon/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function toolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `t-${Math.random()}`, name: "loop", arguments: { value: "x" } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

// A tool that never asks the loop to terminate — so without a turn cap the agent would call it forever.
const loopTool: AgentTool<ReturnType<typeof Type.Object>, { value: string }> = {
	name: "loop",
	label: "Loop",
	description: "Always returns; never terminates the batch.",
	parameters: Type.Object({ value: Type.String() }),
	async execute() {
		return { content: [{ type: "text", text: "again" }], details: { value: "x" } };
	},
};

describe("Agent maxTurns", () => {
	it("stops an otherwise-infinite tool loop at exactly maxTurns provider requests", async () => {
		let streamCalls = 0;
		const agent = new Agent({
			maxTurns: 3,
			initialState: { model: createModel(), tools: [loopTool], systemPrompt: "" },
			streamFn: () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				// Every turn returns another tool call: the loop can only be bounded by the turn cap.
				queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: toolCallMessage() }));
				return stream;
			},
		});

		const events: AgentEvent[] = [];
		const unsub = agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("go");
		unsub();

		// Exactly maxTurns provider requests, then a clean stop.
		expect(streamCalls).toBe(3);
		const turnEnds = events.filter((e) => e.type === "turn_end");
		expect(turnEnds.length).toBe(3);
		// The loop ended cleanly with an agent_end (not left hanging, not an error message).
		expect(events.some((e) => e.type === "agent_end")).toBe(true);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("does not cap turns when maxTurns is undefined (terminates naturally)", async () => {
		let streamCalls = 0;
		const agent = new Agent({
			initialState: { model: createModel(), tools: [loopTool], systemPrompt: "" },
			streamFn: () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					// First turn calls the tool; second turn ends the conversation with plain text.
					if (streamCalls === 1) {
						stream.push({ type: "done", reason: "toolUse", message: toolCallMessage() });
					} else {
						stream.push({
							type: "done",
							reason: "stop",
							message: {
								...toolCallMessage(),
								content: [{ type: "text", text: "final answer" }],
								stopReason: "stop",
							},
						});
					}
				});
				return stream;
			},
		});

		await agent.prompt("go");
		expect(streamCalls).toBe(2);
	});
});
