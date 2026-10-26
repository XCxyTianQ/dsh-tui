// 单元飞轮：Session 模型 —— 用 FakeHost 替身模拟 host，不碰网络、不调真实模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, PTC_PRESET } from "../lib/session.js";

/**
 * 内存版 host 替身：实现 request(method, payload)。
 * prompt 后异步长出完整的一轮事件（turn/start → user/message →
 * assistant/message → turn/end），与真实 host 的时序一致。
 */
class FakeHost {
	constructor({ autoEnd = true, endReason = { kind: "completed" }, turnDelayMs = 15 } = {}) {
		this.autoEnd = autoEnd;
		this.endReason = endReason;
		this.turnDelayMs = turnDelayMs;
		this.sessionId = "session-fake";
		this.turn = 0;
		this.events = [];
		this.requestLog = [];
	}

	#push(type, data) {
		this.events.push({
			type,
			seq: this.events.length,
			time: 1_700_000_000_000 + this.events.length,
			data
		});
	}

	#spawnTurn(text) {
		setTimeout(() => {
			this.turn += 1;
			this.#push("turn/start", { turn: this.turn });
			this.#push("user/message", {
				source: { kind: "user" },
				content: [{ type: "text", text }]
			});
			this.#push("assistant/message", {
				turn: this.turn,
				step: 0,
				message: {
					id: `m-${this.turn}`,
					role: "assistant",
					content: [{ type: "text", text: `回答 ${this.turn}` }],
					source: { kind: "model" }
				},
				usage: { inputTokens: 5, outputTokens: 2 }
			});
			this.#push("turn/end", { turn: this.turn, reason: this.endReason });
		}, this.turnDelayMs);
	}

	async request(method, payload) {
		this.requestLog.push({ method, payload });
		switch (method) {
			case "session.create":
				this.sessionId = payload.sessionId ?? "session-fake";
				this.events = [];
				return { sessionId: this.sessionId, agentPreset: payload.agentPreset ?? null };
			case "session.list":
				return {
					items: [
						{
							sessionId: "session-fake",
							blank: true,
							running: false,
							updatedAt: 1,
							agentPreset: "code",
							cwd: "C:\\work"
						}
					]
				};
			case "session.history":
				return { events: this.events.map((event) => ({ event })), hasMore: false };
			case "session.prompt":
				if (this.autoEnd) this.#spawnTurn(payload.content[0].text);
				return { accepted: true };
			default:
				throw new Error(`unexpected method: ${method}`);
		}
	}
}

test("Session.create 默认走 PTC 模式（agentPreset=code）并透传 cwd", async () => {
	const host = new FakeHost();
	const session = await Session.create(host, { cwd: "C:\\work" });
	assert.equal(session.sessionId, "session-fake");
	assert.equal(session.agentPreset, PTC_PRESET);
	const createCall = host.requestLog.find((r) => r.method === "session.create");
	assert.equal(createCall.payload.agentPreset, "code");
	assert.equal(createCall.payload.cwd, "C:\\work");
});

test("Session.create 允许显式覆盖 agentPreset", async () => {
	const host = new FakeHost();
	const session = await Session.create(host, { agentPreset: "standard" });
	assert.equal(session.agentPreset, "standard");
});

test("Session.open 复用已存在会话；找不到抛 session-not-found", async () => {
	const host = new FakeHost();
	const session = await Session.open(host, "session-fake");
	assert.equal(session.sessionId, "session-fake");
	assert.equal(session.agentPreset, "code");

	await assert.rejects(() => Session.open(host, "session-missing"), (error) => {
		assert.equal(error.code, "session-not-found");
		return true;
	});
});

test("Session.openRecent：优先客户端记忆，其次最近非 blank 会话", async () => {
	// mock registry：记忆指向 session-c（但已被归档/blank）
	const mem = { sessionId: "session-old", cwd: "", agentPreset: "code" };
	const items = [
		{ sessionId: "session-old", blank: true, running: false, updatedAt: 1, agentPreset: "code" },
		{ sessionId: "session-new", blank: false, running: false, updatedAt: 100, agentPreset: "code", cwd: "C:\\w" }
	];
	// 用 FakeHost 但覆盖 list
	const host = new FakeHost();
	host.request = async (method, payload) => {
		if (method === "session.list") return { items };
		if (method === "session.create") return { sessionId: "session-x", agentPreset: "code" };
		throw new Error(`unexpected ${method}`);
	};
	// openRecent 会先读真正的 registry（无 → null），再回退 list 里最近非 blank
	const sess = await Session.openRecent(host, { remembered: mem, items });
	assert.equal(sess.sessionId, "session-new");
});

test("openRecent:list 全是 blank 且无记忆 → null", async () => {
	const host = new FakeHost();
	host.request = async (method) => {
		if (method === "session.list") return { items: [{ sessionId: "s-blank", blank: true, running: false, updatedAt: 1 }] };
		throw new Error(`unexpected ${method}`);
	};
	const sess = await Session.openRecent(host, { remembered: null, items: [{ sessionId: "s-blank", blank: true }] });
	assert.equal(sess, null);
});

test("converse：prompt → 轮询 → 折叠出 user + assistant 回复，turn completed", async () => {
	const host = new FakeHost({ turnDelayMs: 10 });
	const session = await Session.create(host);
	const view = await session.converse("你好", { timeoutMs: 2000, pollMs: 5 });

	assert.equal(view.accepted, true);
	assert.equal(view.turnEnd.reason.kind, "completed");
	const texts = view.messages.map((m) => m.text);
	assert.deepEqual(texts, ["你好", "回答 1"]);
	assert.equal(view.messages[1].usage.outputTokens, 2);
});

test("converse 复用时只认 prompt 之后的新轮（不把旧轮当本轮）", async () => {
	const host = new FakeHost({ turnDelayMs: 10 });
	const session = await Session.create(host);
	// 第一轮：完整走完
	const first = await session.converse("第一问", { timeoutMs: 2000, pollMs: 5 });
	assert.equal(first.turnEnd.turn, 1);// 第二轮：基线后应出现 turn=2 的新轮
	const second = await session.converse("第二问", { timeoutMs: 2000, pollMs: 5 });
	assert.equal(second.turnEnd.turn, 2);
	assert.deepEqual(second.messages.map((m) => m.text), ["第一问", "回答 1", "第二问", "回答 2"]);
});

test("converse 以 error 结束 → 抛 turn-error", async () => {
	const host = new FakeHost({
		turnDelayMs: 10,
		endReason: { kind: "error", error: { message: "model blew up", code: "LLM" } }
	});
	const session = await Session.create(host);
	await assert.rejects(() => session.converse("hi", { timeoutMs: 2000, pollMs: 5 }), (error) => {
		assert.equal(error.code, "turn-error");
		assert.match(error.message, /model blew up/);
		return true;
	});
});

test("converse 超时 → 抛 turn-timeout", async () => {
	const host = new FakeHost({ autoEnd: false });
	const session = await Session.create(host);
	await assert.rejects(() => session.converse("hi", { timeoutMs: 60, pollMs: 10 }), (error) => {
		assert.equal(error.code, "turn-timeout");
		return true;
	});
});

test("converse 收到 slash 命令 → 返回 command 且不等待回合", async () => {
	const host = new FakeHost({ autoEnd: false });
	const session = await Session.create(host);
	// 让 host 替身像真实 host 一样返回 command 槽
	const originalRequest = host.request.bind(host);
	host.request = async (method, payload) => {
		if (method === "session.prompt") return { accepted: true, command: { kind: "success", text: "ok" } };
		return originalRequest(method, payload);
	};
	const view = await session.converse("/status", { timeoutMs: 200 });
	assert.equal(view.command.kind, "success");
	assert.equal(view.turnEnd, null); // 没有等待回合
});

test("converse 不会把旧轮的 turn/end 当成当前轮的（新 user 事件出现但新轮未结束时仍继续等）", async () => {
	// 场景（Codex 评审 #2）：会话里已有一条**旧的已完成回合**；本次 prompt 后只有新 user/message
	// 出现（推进了 lastSeq），但新轮 turn/end 迟迟不到。旧实现因 `view.lastSeq > baseSeq`
	// 提前 return 了旧 turn；修复后应按 `turnEnd.seq > baseSeq` 继续等 → 超时。
	const base = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		{ type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "旧问题" }] } },
		{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "旧回答" }], source: { kind: "model" } }, usage: {} } },
		{ type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } } // 旧轮已结束
	];
	// 基线页：回完整旧轮（baseSeq=3，旧 turn/end 已在基线内）；之后回「旧轮 + 新 user/message」（永不结束新轮）。
	const host = {
		request: async (method) => {
			if (method === "session.history") {
				return {
					events: base.concat([
						{ type: "user/message", seq: 4, time: 4, data: { source: { kind: "user" }, content: [{ type: "text", text: "新问题" }] } }
					]).map((event) => ({ event })),
					hasMore: false
				};
			}
			if (method === "session.prompt") return { accepted: true };
			throw new Error(`unexpected ${method}`);
		}
	};
	const session = new Session(host, "session-fake", { agentPreset: "code" });
	await assert.rejects(() => session.converse("新问题", { timeoutMs: 80, pollMs: 10 }), (error) => {
		assert.equal(error.code, "turn-timeout", "新轮未结束应超时而非提前返回旧轮");
		return true;
	});
});

test("Session.create：host 不认识默认 preset 时退回 host 默认，不阻断建会话", async () => {
	const calls = [];
	const host = {
		async request(method, payload) {
			calls.push({ method, payload });
			if (method === "session.create" && payload.agentPreset) {
				const error = new Error("agent-preset/not-found: unknown preset code");
				error.code = "agent-preset/not-found";
				throw error;
			}
			return { sessionId: "session-fallback", agentPreset: "standard" };
		}
	};

	const session = await Session.create(host, { cwd: "/w" });
	assert.equal(session.sessionId, "session-fallback");
	assert.equal(session.agentPreset, "standard");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].payload.agentPreset, undefined);
	assert.equal(calls[1].payload.cwd, "/w");
});

