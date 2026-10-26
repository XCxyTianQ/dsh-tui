/**
 * mux 事件流客户端：连接 `/api/remote.mux` WebSocket，订阅一个会话的 follow 流。
 *
 * DSH 0.2.x 的流式契约（实测自 host 0.2.1-rc.2）：
 * - 传输：`ws://…/api/remote.mux`（旧的 `GET /api/events.mux` SSE 已删除，返回 404）；
 * - 客户端发 `{ type: "open", streamId, endpoint: "session/follow", payload: { args: { request } } }`；
 * - 服务端回 `{ type: "item", streamId, value }` / `{ type: "error", streamId, error }` / `{ type: "end", streamId }`；
 * - `value.type` 判别：`snapshot`（开窗快照 + cursor）、`event`（durable 事件）、`assistant-stream`（流式增量）。
 *
 * 重要：follow 流是**会话激活开关** —— 没有 follow 时 prompt 只会进 Agent inbox 而不会开跑
 * （实测：只发 prompt 时事件数恒为 0；打开 follow 后再 prompt 立刻产生事件并走完回合）。
 *
 * 本模块只做传输与形状翻译：把新帧翻成 live.js 认识的旧 `{type, payload}` 信封，
 * 业务折叠仍在 live.js。
 */
import { DshClient } from "./client.js";

const STREAM_PATH = "/api/remote.mux";
const FOLLOW_ENDPOINT = "session/follow";

/** 从 SSE 块里抽出 data: 载荷（历史兼容；新 host 不再使用）。 */
export function extractSseData(chunk) {
	return chunk
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice(6))
		.join("");
}

/** 解析一帧旧 SSE 载荷；保留给历史测试。 */
export function parseServerRequest(raw) {
	try {
		const message = JSON.parse(raw);
		if (!message || message.type !== "server-request" || typeof message.payload !== "object") {
			return null;
		}
		return message;
	} catch {
		return null;
	}
}

/**
 * 把 `/api/remote.mux` 的服务端帧翻译成 live.js 认识的 envelope。
 * @param {object} frame - `{ type: "item"|"error"|"end", streamId, value|error }`
 * @param {{ sessionId?: string }} [context]
 * @returns {{ type: string, rpcId: string|null, method: string, payload: object }|null}
 */
export function mapRemoteStreamFrame(frame, { sessionId } = {}) {
	if (!frame || typeof frame.type !== "string") return null;
	if (frame.type === "error") {
		return envelope({ type: "stream/error", error: frame.error ?? { code: "internal", message: "remote stream failed" } });
	}
	if (frame.type !== "item") return null;
	const value = frame.value;
	if (!value || typeof value !== "object") return null;
	switch (value.type) {
		case "snapshot":
			return envelope({ type: "session/subscribed", sessionId, lastSeq: typeof value.cursor === "number" ? value.cursor : -1 });
		case "event":
			return envelope({ type: "session/event", sessionId, event: value.event });
		case "assistant-stream": {
			const frameValue = value.frame;
			if (!frameValue || frameValue.type !== "chunk") return null;
			return envelope({ type: "assistant/chunk", sessionId, data: { chunk: frameValue.chunk } });
		}
		default:
			return null;
	}
}

function envelope(payload) {
	return { type: "server-request", rpcId: null, method: FOLLOW_ENDPOINT, payload };
}

/**
 * 一次 follow 订阅的传输实现。
 * @param {string} baseUrl - host 根地址（http/https，可带 token）。
 * @param {object} [options]
 * @param {DshClient} [options.client] - 复用其认证 cookie（推荐）。
 * @param {string} [options.sessionId] - 要 follow 的会话。
 * @param {number} [options.maxMessages] - follow 开窗的消息上限。
 * @param {typeof WebSocket} [options.WebSocketImpl] - 注入测试用实现。
 */
export class MuxStream {
	constructor(baseUrl, { client = null, sessionId = null, maxMessages = 64, WebSocketImpl } = {}) {
		this.baseUrl = String(baseUrl ?? "").replace(/\/+$/, "");
		this.client = client;
		this.sessionId = sessionId;
		this.maxMessages = maxMessages;
		this.WebSocketImpl = WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
	}

	#wsUrl() {
		return this.baseUrl.replace(/^http/i, "ws") + STREAM_PATH;
	}

	/** 打开 follow 帧。 */
	#openFrame(streamId) {
		return {
			type: "open",
			streamId,
			endpoint: FOLLOW_ENDPOINT,
			payload: {
				args: {
					request: {
						address: { kind: "session", sessionId: this.sessionId },
						maxMessages: this.maxMessages
					}
				}
			}
		};
	}

	/**
	 * 逐帧读取 follow 流。
	 * @param {{ signal?: AbortSignal, onOpen?: () => void, WebSocketImpl?: typeof WebSocket }} [options]
	 */
	async *frames({ signal, onOpen, WebSocketImpl } = {}) {
		const Impl = WebSocketImpl ?? this.WebSocketImpl;
		if (!Impl) {
			throw new Error("无 WebSocket 实现（Node ≥22 内建全局 WebSocket，或注入 WebSocketImpl）");
		}
		if (!this.sessionId) throw new Error("MuxStream requires a sessionId to follow");
		if (this.client) await this.client.authenticate();
		const cookie = this.client ? this.client.cookie : null;
		const ws = cookie
			? new Impl(this.#wsUrl(), { headers: { cookie } })
			: new Impl(this.#wsUrl());
		const streamId = `stream-${Math.random().toString(36).slice(2)}`;
		const inbox = [];
		let closed = false;
		let closeError = null;
		let wake = null;
		const settle = () => { if (wake) { const w = wake; wake = null; w(); } };

		const sendOpen = () => {
			try {
				ws.send(JSON.stringify(this.#openFrame(streamId)));
			} catch (error) {
				closeError = closeError ?? error;
				settle();
			}
		};
		ws.addEventListener("open", () => { onOpen?.(); sendOpen(); settle(); });
		ws.addEventListener("message", (ev) => {
			let frame;
			try {
				frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data ?? ""));
			} catch {
				return; // 坏帧跳过，不杀流
			}
			if (!frame || (frame.streamId !== undefined && frame.streamId !== streamId)) return;
			if (frame.type === "end") { closed = true; settle(); return; }
			const envelopeFrame = mapRemoteStreamFrame(frame, { sessionId: this.sessionId });
			if (envelopeFrame) inbox.push(envelopeFrame);
			settle();
		});
		ws.addEventListener("error", (ev) => {
			closeError = closeError ?? new Error(`transport failure for remote.mux: ${ev.message || "websocket error"}`);
			closed = true;
			settle();
		});
		ws.addEventListener("close", () => { closed = true; settle(); });
		const onAbort = () => { try { ws.close(); } catch {} closed = true; settle(); };
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			for (;;) {
				while (inbox.length === 0 && !closed) {
					await new Promise((r) => { wake = r; });
				}
				if (inbox.length > 0) yield inbox.shift();
				else if (closed) {
					if (closeError) throw closeError;
					return;
				}
			}
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
			try { ws.close(); } catch {}
		}
	}
}

/** 应答一个可应答的 server-request（approval/question），走 `$events/result`。 */
export async function respondTo(client, rpcId, result) {
	return client.respond(rpcId, result);
}


/** 应答一个可应答的 server-request（approval/question），走 `$events/result`（公开 API 旧名）。 */
export async function respond(client, rpcId, result) {
	return client.respond(rpcId, result);
}
