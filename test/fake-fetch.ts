export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Reply = object | Response | ((req: RecordedRequest) => object | Response);

// Routes are matched by URL pathname. A route value is the JSON envelope to return, a full Response, or a function of the request.
export function fakeFetch(routes: Record<string, Reply>) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req: RecordedRequest = { url, method: init.method ?? 'GET', headers, body: String(init.body ?? '') };
    calls.push(req);
    const route = routes[url.pathname];
    if (route === undefined) {
      return new Response('not found', { status: 404 });
    }
    const reply = typeof route === 'function' ? route(req) : route;
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
