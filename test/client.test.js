import test from "node:test";
import assert from "node:assert/strict";
import { DshClient, mintRpcId, mintRequestId, toWireRequest } from "../lib/client.js";

/** 构造一个最小的 fetch Response 替身。 */
function responseFor(body, { status = 200, setCookie } = {}) {
	const headers = {
		get: (name) => (name.toLowerCase() === "set-cookie" ? setCookie ?? null : null),
		getSetCookie: () => (setCookie ? [setCookie] : [])
	};
	return {
		ok: status >= 200 && status < 300,
		status,
		headers,
		json: async () => body,
		text: async () => JSON.stringify(body)
	};
}

function envelope(overrides = {}) {
	return {
		type: "server-response",
		rpcId: overrides.rpcId,
		result: overrides.result ?? { ok: true, value: {} }
	};
}

test("mintRpcId / mintRequestId produce fresh prefixed ids", () => {
	assert.match(mintRpcId(), /^rpc-/);
	assert.notEqual(mintRpcId(), mintRpcId());
	assert.match(mintRequestId(), /^req-/);
	assert.notEqual(mintRequestId(), mintRequestId());
});

test("toWireRequest maps legacy methods onto the Remote endpoints", () => {
	assert.deepEqual(toWireRequest("session.list"), { endpoint: "session/list", payload: { args: { _request: {} } } });
	assert.deepEqual(
		toWireRequest("session.prompt", { sessionId: "s", mode: "queue", content: [] }).endpoint,
		"session/prompt"
	);
	const history = toWireRequest("session.history", { sessionId: "s", maxMessages: 4 });
	assert.equal(history.endpoint, "session/page");
	assert.deepEqual(history.payload, {
		args: { request: { address: { kind: "session", sessionId: "s" }, throughSeq: -1, maxMessages: 4 } }
	});
	assert.deepEqual(history.decode({ records: [{ type: "event", event: { seq: 1 } }], hasMore: true }), {
		events: [{ type: "event", event: { seq: 1 } }],
		hasMore: true
	});
	assert.deepEqual(toWireRequest("subagent.list").local, { items: [] });
});

test("request sends the Remote envelope without auth when no token is configured", async () => {
	let captured;
	const client = new DshClient("http://example.test", {
		fetchImpl: async (url, options) => {
			captured = { url, options };
			const body = JSON.parse(options.body);
			return responseFor(envelope({ rpcId: body.rpcId, result: { ok: true, value: { items: [1, 2] } } }));
		}
	});

	const value = await client.request("session.list");
	assert.deepEqual(value, { items: [1, 2] });
	assert.equal(captured.url, "http://example.test/api/session/list");
	assert.equal(captured.options.method, "POST");
	assert.match(captured.options.headers["content-type"], /application\/json/);
	assert.equal(captured.options.headers.cookie, undefined);

	const body = JSON.parse(captured.options.body);
	assert.equal(body.type, "client-request");
	assert.equal(body.method, "session/list");
	assert.match(body.rpcId, /^rpc-/);
	assert.deepEqual(body.payload, { args: { _request: {} } });
});

test("connect exchanges the launch token for a cookie and later requests carry it", async () => {
	const calls = [];
	const client = new DshClient("http://example.test/?token=tok-123", {
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			if (url.includes("/connect?")) {
				return responseFor(null, { status: 302, setCookie: "dsh-auth-abc=v2.payload.sig; Path=/; HttpOnly" });
			}
			const body = JSON.parse(options.body);
			return responseFor(envelope({ rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }));
		}
	});

	await client.request("session.list");
	assert.equal(calls.length, 2);
	assert.match(calls[0].url, /^http:\/\/example\.test\/connect\?token=tok-123&interactions=answer$/);
	assert.equal(calls[0].options.redirect, "manual");
	assert.equal(calls[1].options.headers.cookie, "dsh-auth-abc=v2.payload.sig");

	// 第二次调用复用同一 cookie，不重复 /connect。
	await client.request("session.list");
	assert.equal(calls.length, 3);
});

test("a 401 response re-authenticates once and retries", async () => {
	const calls = [];
	let posts = 0;
	const client = new DshClient("http://example.test", {
		token: "tok",
		fetchImpl: async (url, options) => {
			calls.push(url);
			if (url.includes("/connect?")) {
				return responseFor(null, { status: 302, setCookie: "dsh-auth-new=v2.p.s; Path=/" });
			}
			posts += 1;
			if (posts === 1) return responseFor({}, { status: 401 });
			const body = JSON.parse(options.body);
			return responseFor(envelope({ rpcId: body.rpcId, result: { ok: true, value: { items: [{ sessionId: "s1" }] } } }));
		}
	});

	const value = await client.request("session.list");
	assert.deepEqual(value, { items: [{ sessionId: "s1" }] });
	assert.equal(posts, 2);
	assert.ok(calls.filter((url) => url.includes("/connect?")).length >= 2);
});

test("request throws a structured error on business failure", async () => {
	const client = new DshClient("http://example.test", {
		fetchImpl: async (_url, options) => {
			const body = JSON.parse(options.body);
			return responseFor({
				type: "server-response",
				rpcId: body.rpcId,
				result: { ok: false, error: { code: "session-not-found", message: "no such session", details: { sessionId: "x" } } }
			});
		}
	});

	await assert.rejects(
		() => client.request("session.history", { sessionId: "x" }),
		(error) => error.code === "session-not-found" && /no such session/.test(error.message)
	);
});

test("request throws on transport failure", async () => {
	const client = new DshClient("http://example.test", {
		fetchImpl: async () => responseFor({}, { status: 500 })
	});
	await assert.rejects(() => client.request("session.list"), /HTTP 500/);
});

test("request rejects an rpcId mismatch", async () => {
	const client = new DshClient("http://example.test", {
		fetchImpl: async () => responseFor({ type: "server-response", rpcId: "rpc-other", result: { ok: true, value: {} } })
	});
	await assert.rejects(() => client.request("session.list"), /rpcId mismatch/);
});

test("respond posts to the Remote event-result endpoint", async () => {
	let captured;
	const client = new DshClient("http://example.test", {
		fetchImpl: async (url, options) => {
			captured = { url, options };
			return responseFor({ accepted: true });
		}
	});

	await client.respond("rpc-1", { ok: true, value: { sessionId: "s" } });
	assert.equal(captured.url, "http://example.test/api/$events/result");
	const body = JSON.parse(captured.options.body);
	assert.equal(body.type, "client-response");
	assert.equal(body.rpcId, "rpc-1");
});

