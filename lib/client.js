import { randomUUID } from "node:crypto";

const DEFAULT_BASE = "http://127.0.0.1:3080";
const CONNECT_PATH = "/connect";
const RESULT_PATH = "/api/$events/result";
const AUTH_COOKIE_PREFIX = "dsh-auth-";

/** Mint a fresh rpcId (the initiator always mints; responses echo it). */
export function mintRpcId() {
	return `rpc-${randomUUID()}`;
}

/** Mint a prompt requestId (persisted on the accepted user message). */
export function mintRequestId() {
	return `req-${randomUUID()}`;
}

function env(name) {
	try {
		return process.env[name] ?? null;
	} catch {
		return null;
	}
}

/** Translate the legacy history payload into the `session/page` request. */
function pageRequest(payload = {}) {
	const { sessionId } = payload;
	if (!sessionId) throw new Error("session.history requires a sessionId");
	const request = { address: { kind: "session", sessionId }, throughSeq: typeof payload.throughSeq === "number" ? payload.throughSeq : -1 };
	if (payload.beforeSeq !== undefined) request.beforeSeq = payload.beforeSeq;
	if (payload.maxMessages !== undefined) request.maxMessages = payload.maxMessages;
	return request;
}

/**
 * 客户端方法 → 新 Remote 端点映射。
 *
 * DSH 0.2.x 把 apiproxy 的 unary 调用迁到 Typert Remote：
 * 端点名从点号改成 `namespace/method`，业务参数包进 `payload.args`，
 * 且 args 的键名由方法 descriptor 决定（多数是 `request`，`session/list` 是 `_request`）。
 * 这里保留上游的旧方法名作为「客户端词汇」，在 carrier 层翻译成线上契约。
 */
const WIRE = {
	"session.list": {
		endpoint: "session/list",
		args: () => ({ _request: {} })
	},
	"session.create": {
		endpoint: "session/create",
		args: (payload) => ({ request: payload })
	},
	"session.prompt": {
		endpoint: "session/prompt",
		args: (payload) => ({ request: { ...payload, requestId: payload.requestId ?? mintRequestId() } })
	},
	"session.cancel": {
		endpoint: "session/cancel",
		args: (payload) => ({ request: payload })
	},
	"session.history": {
		endpoint: "session/page",
		args: (payload) => ({ request: pageRequest(payload) }),
		decode: (value) => ({ events: value?.records ?? [], hasMore: value?.hasMore === true })
	},
	"session.projections": {
		endpoint: "session/projections",
		args: (payload) => ({ request: payload })
	},
	"session.modelCatalog": {
		endpoint: "session/modelCatalog",
		args: () => ({})
	},
	// 新 host 不再提供 subagents/list（只剩 subagents/prompt 与 subagents/interruptByParent）。
	// M1 阶段先返回空列表，HUD 子代理计数为 0；等流式接入后再按会话投影重建。
	"subagent.list": {
		local: () => ({ items: [] })
	}
};

/**
 * 把一次客户端调用翻译成线上请求（供测试与排查使用）。
 * @param {string} method - 客户端方法名，如 `session.list`。
 * @param {object} [payload]
 * @returns {{ endpoint: string, payload: { args: object }, decode?: (value: object) => object }|{ local: object }}
 */
export function toWireRequest(method, payload = {}) {
	const route = WIRE[method];
	if (!route) throw new Error(`unsupported dsh method: ${method}`);
	if (route.local) return { local: route.local(payload) };
	return { endpoint: route.endpoint, payload: { args: route.args(payload) }, ...(route.decode ? { decode: route.decode } : {}) };
}

/**
 * DSH 客户端载体：一元请求（unary Remote）over HTTP。
 *
 * 两个平面：
 * - 认证：host 对每个 /api 请求都做 browser-auth（连 loopback 也不例外）。客户端
 *   用 launch token 走 `GET /connect?token=…&interactions=answer` 换 `dsh-auth-*`
 *   cookie（与 authority 绑定、30 天），后续每个请求带 cookie；401 时重连一次。
 * - 契约：POST `/api/<namespace>/<method>`，body 是
 *   `{ type: "client-request", rpcId, method: "<namespace>/<method>", payload: { args } }`，
 *   response 是 `{ type: "server-response", rpcId, result: { ok, value|error } }`。
 */
export class DshClient {
	/**
	 * @param {string} [baseUrl] - host 根地址；可带 `?token=…`（`dsh web` 启动时打印的那种）。
	 * @param {{ token?: string, cookie?: string, fetchImpl?: typeof fetch }} [options]
	 */
	constructor(baseUrl = DEFAULT_BASE, options = {}) {
		const url = new URL(baseUrl);
		this.token = options.token ?? url.searchParams.get("token") ?? env("DSH_TOKEN");
		url.search = "";
		url.hash = "";
		this.baseUrl = url.href.replace(/\/+$/, "");
		this.cookie = options.cookie ?? env("DSH_COOKIE");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.authPromise = null;
	}

	/** Whether the carrier still needs a browser-auth cookie. */
	get needsAuth() {
		return this.cookie === null;
	}

	/**
	 * 用 launch token 换 browser-auth cookie（一个 peer）。
	 * @returns {Promise<string>} `name=value` 形式的 cookie。
	 */
	async connect() {
		if (!this.token) {
			throw new Error("dsh web authentication required: start with DSH_URL=<url printed by dsh web> or set DSH_TOKEN");
		}
		const response = await this.fetchImpl(
			`${this.baseUrl}${CONNECT_PATH}?token=${encodeURIComponent(this.token)}&interactions=answer`,
			{ method: "GET", redirect: "manual" }
		);
		const setCookie = typeof response.headers?.getSetCookie === "function"
			? response.headers.getSetCookie()[0]
			: response.headers?.get?.("set-cookie");
		const cookie = String(setCookie ?? "").split(";", 1)[0];
		if (!cookie.startsWith(AUTH_COOKIE_PREFIX)) {
			throw new Error(`dsh web authentication failed: /connect returned HTTP ${response.status}`);
		}
		this.cookie = cookie;
		return cookie;
	}

	/** 确保已拿到 browser-auth cookie（公开版，供流式传输复用）。 */
	async authenticate() {
		await this.#authenticate();
		return this.cookie;
	}

	async #authenticate() {
		if (this.cookie !== null || !this.token) return;
		if (this.authPromise === null) {
			this.authPromise = this.connect().catch((error) => {
				this.authPromise = null;
				throw error;
			});
		}
		await this.authPromise;
	}

	#headers() {
		const headers = { "content-type": "application/json" };
		if (this.cookie !== null) headers.cookie = this.cookie;
		return headers;
	}

	async #post(endpoint, payload) {
		const rpcId = mintRpcId();
		const response = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, {
			method: "POST",
			headers: this.#headers(),
			body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload })
		});
		return { response, rpcId };
	}

	/**
	 * 执行一次客户端调用（旧方法名），返回业务值。
	 * @param {string} method - 如 `session.list` / `session.create` / `session.history`。
	 * @param {object} [payload]
	 */
	async request(method, payload = {}) {
		const route = WIRE[method];
		if (!route) throw new Error(`unsupported dsh method: ${method}`);
		if (route.local) return route.local(payload);

		const body = { args: route.args(payload) };
		await this.#authenticate();
		let { response, rpcId } = await this.#post(route.endpoint, body);
		if (response.status === 401 && this.token) {
			// peer 过期或 cookie 失效：重换一次再试。
			this.cookie = null;
			this.authPromise = null;
			await this.#authenticate();
			({ response, rpcId } = await this.#post(route.endpoint, body));
		}
		if (!response.ok) {
			const hint = response.status === 401 && !this.token
				? " (host requires browser-auth: start with DSH_URL=<url printed by dsh web> or set DSH_TOKEN)"
				: "";
			throw new Error(`HTTP ${response.status} from ${method}${hint}`);
		}
		const message = await response.json();
		if (message.type !== "server-response") {
			throw new Error(`unexpected response type: ${String(message.type)}`);
		}
		if (message.rpcId !== rpcId) {
			throw new Error("rpcId mismatch in server response");
		}
		if (!message.result.ok) {
			const error = message.result.error;
			const errorObject = new Error(`${error.code}: ${error.message}`);
			errorObject.code = error.code;
			errorObject.details = error.details;
			throw errorObject;
		}
		const value = message.result.value;
		return route.decode ? route.decode(value) : value;
	}

	/**
	 * 应答一个 server-request（approval/question requested 的可应答帧）。
	 * 新 host 的应答通道是 `POST /api/$events/result`（旧名 `/api/respond` 已删除）。
	 * @param {string} rpcId
	 * @param {{ ok: true, value: object }|{ ok: false, error: object }} result
	 */
	async respond(rpcId, result) {
		await this.#authenticate();
		const response = await this.fetchImpl(`${this.baseUrl}${RESULT_PATH}`, {
			method: "POST",
			headers: this.#headers(),
			body: JSON.stringify({ type: "client-response", rpcId, result })
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from respond`);
		}
		return response.json();
	}
}

