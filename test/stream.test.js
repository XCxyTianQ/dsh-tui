// 单元飞轮：/api/remote.mux follow 传输层 —— open 帧、形状翻译、坏帧容错、错误帧。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSseData, parseServerRequest, mapRemoteStreamFrame, MuxStream } from "../lib/stream.js";

test("extractSseData：保留旧 SSE 解析（历史兼容）", () => {
	const chunk = 'event: msg\ndata: {"a":1,\ndata: "b":2}\n\n';
	assert.equal(extractSseData(chunk), '{"a":1,"b":2}');
	assert.equal(extractSseData(": connected"), "");
});

test("parseServerRequest：旧信封解析仍可用", () => {
	const raw = JSON.stringify({ type: "server-request", rpcId: "r-1", method: "events.mux", payload: { type: "stream/error" } });
	assert.equal(parseServerRequest(raw).rpcId, "r-1");
	assert.equal(parseServerRequest("{not json"), null);
});

test("mapRemoteStreamFrame：snapshot → session/subscribed（cursor 即 lastSeq）", () => {
	const frame = { type: "item", streamId: "s", value: { type: "snapshot", cursor: 7, records: [], hasMore: false } };
	const envelope = mapRemoteStreamFrame(frame, { sessionId: "sess" });
	assert.equal(envelope.payload.type, "session/subscribed");
	assert.equal(envelope.payload.sessionId, "sess");
	assert.equal(envelope.payload.lastSeq, 7);
});

test("mapRemoteStreamFrame：event → session/event，assistant-stream chunk → assistant/chunk", () => {
	const event = mapRemoteStreamFrame({ type: "item", streamId: "s", value: { type: "event", event: { type: "turn/start", seq: 1 } } }, { sessionId: "sess" });
	assert.equal(event.payload.type, "session/event");
	assert.equal(event.payload.event.seq, 1);

	const chunk = mapRemoteStreamFrame({ type: "item", streamId: "s", value: { type: "assistant-stream", frame: { type: "chunk", chunk: { type: "delta", text: "hi" } } } }, { sessionId: "sess" });
	assert.equal(chunk.payload.type, "assistant/chunk");
	assert.deepEqual(chunk.payload.data.chunk, { type: "delta", text: "hi" });

	assert.equal(mapRemoteStreamFrame({ type: "item", streamId: "s", value: { type: "assistant-stream", frame: { type: "end" } } }), null);
});

test("mapRemoteStreamFrame：error 帧 → stream/error；end / 未知帧 → null", () => {
	const error = mapRemoteStreamFrame({ type: "error", streamId: "s", error: { code: "boom", message: "x" } });
	assert.equal(error.payload.type, "stream/error");
	assert.equal(error.payload.error.code, "boom");
	assert.equal(mapRemoteStreamFrame({ type: "end", streamId: "s" }), null);
	assert.equal(mapRemoteStreamFrame({ type: "item", streamId: "s", value: { type: "unknown" } }), null);
});

/** 收到 open 帧后按脚本回放服务端帧的假 WebSocket。 */
function scriptedWebSocket(script, { failWith = null } = {}) {
	return class FakeWS {
		constructor(url, options = {}) {
			this.url = url;
			this.options = options;
			this.sent = [];
			this._listeners = {};
			queueMicrotask(() => this._emit("open"));
		}
		addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
		removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
		_emit(type, data) { for (const fn of this._listeners[type] || []) fn(data ?? {}); }
		send(raw) {
			const frame = JSON.parse(raw);
			this.sent.push(frame);
			if (frame.type !== "open") return;
			queueMicrotask(() => {
				if (failWith) { this._emit("error", { message: failWith }); return; }
				for (const reply of script(frame)) this._emit("message", { data: JSON.stringify(reply) });
				this._emit("close");
			});
		}
		close() { this._emit("close"); }
	};
}

test("MuxStream.frames：连 remote.mux、发 session/follow open 帧、逐帧 yield 翻译后的信封", async () => {
	const instances = [];
	const Scripted = scriptedWebSocket((open) => [
		{ type: "item", streamId: open.streamId, value: { type: "snapshot", cursor: 5 } },
		{ type: "item", streamId: open.streamId, value: { type: "event", event: { type: "turn/start", seq: 6 } } },
		{ type: "item", streamId: "other-stream", value: { type: "event", event: { type: "turn/end", seq: 9 } } },
		{ type: "end", streamId: open.streamId }
	]);
	class Capturing extends Scripted { constructor(url, options) { super(url, options); instances.push(this); } }

	const seen = [];
	const stream = new MuxStream("http://10.0.0.5:3090", { sessionId: "session-1", WebSocketImpl: Capturing });
	for await (const envelope of stream.frames({})) seen.push(envelope);

	assert.equal(instances.length, 1);
	assert.equal(instances[0].url, "ws://10.0.0.5:3090/api/remote.mux");
	const open = instances[0].sent[0];
	assert.equal(open.type, "open");
	assert.equal(open.endpoint, "session/follow");
	assert.deepEqual(open.payload.args.request.address, { kind: "session", sessionId: "session-1" });
	assert.equal(typeof open.streamId, "string");

	assert.equal(seen.length, 2); // 别的 streamId 被丢弃；end 不收
	assert.equal(seen[0].payload.type, "session/subscribed");
	assert.equal(seen[0].payload.lastSeq, 5);
	assert.equal(seen[1].payload.type, "session/event");
	assert.equal(seen[1].payload.event.type, "turn/start");
});

test("MuxStream.frames：复用 client 的认证 cookie，并对 error 帧抛错", async () => {
	let capturedUrl;
	let capturedOptions;
	const Scripted = scriptedWebSocket(() => [], { failWith: "boom" });
	class Capturing extends Scripted {
		constructor(url, options) { super(url, options); capturedUrl = url; capturedOptions = options; }
	}
	const client = {
		baseUrl: "http://10.0.0.5:3090",
		cookie: null,
		async authenticate() { this.cookie = "dsh-auth-x=v2.p.s"; return this.cookie; }
	};
	const stream = new MuxStream(client.baseUrl, { client, sessionId: "session-2", WebSocketImpl: Capturing });
	await assert.rejects(async () => {
		for await (const _envelope of stream.frames({})) { /* drain */ }
	}, /transport failure for remote\.mux/);
	assert.equal(capturedUrl, "ws://10.0.0.5:3090/api/remote.mux");
	assert.equal(capturedOptions.headers.cookie, "dsh-auth-x=v2.p.s");
});

