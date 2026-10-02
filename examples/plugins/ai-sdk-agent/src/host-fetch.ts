import type { Host } from "@buzz/author";

/** `ctx.host.fetch` is proposed on branch art4/host-fetch and absent from older builds. */
type StreamingHost = Host & {
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/** A `fetch` for the AI SDK that leaves the webview through the host, because the
 * app's CSP blocks provider origins. Streams where the host can; otherwise the whole
 * body arrives at once through `host.request`, which the host caps at 30 seconds.
 * `host` is read on every call so the service sees the calling plugin's context. */
export function hostFetch(host: () => StreamingHost): typeof fetch {
	return async (input, init) => {
		const service = host();
		if (typeof service.fetch === "function") return service.fetch(input, init);
		const source = input instanceof Request ? input : undefined;
		const signal = init?.signal ?? source?.signal;
		signal?.throwIfAborted();
		const method = (init?.method ?? source?.method ?? "GET").toUpperCase();
		const body = init?.body ?? (source ? await source.text() : undefined);
		if (body != null && typeof body !== "string")
			throw new TypeError("Host requests send text bodies only");
		const response = await service.request({
			url: source?.url ?? String(input),
			method: method as "POST",
			headers: Object.fromEntries(
				new Headers(init?.headers ?? source?.headers),
			),
			...(body ? { body } : {}),
		});
		signal?.throwIfAborted();
		return new Response(
			[101, 204, 205, 304].includes(response.status) ? null : response.body,
			{ status: response.status, headers: response.headers },
		);
	};
}
