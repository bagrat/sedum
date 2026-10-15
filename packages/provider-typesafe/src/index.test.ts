import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type ResolverCandidates } from "@sedum-dev/core";
import type { Fetch } from "@typesafe-ai/sdk";
import { TypeSafeAdapter } from "./index.js";
import { buildResolverRequest } from "./request.js";

const offered: ResolverCandidates = {
  complete: true,
  options: [
    {
      kind: "candidate",
      candidate: {
        id: "a",
        tag: "button",
        role: "button",
        name: "Buy",
        peers: [],
        editable: false,
        disabled: false,
      },
    },
    { kind: "none", id: "none" },
  ],
};
const choiceReply = {
  answers: {
    target: {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.8, none: 0.2 },
    },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 100, output_tokens: 0 },
};
const judgeReply = {
  answers: {
    holds: { type: "noul", noul: 0.9 },
    contradicted: { type: "noul", noul: 0.8 },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 200, output_tokens: 0 },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fake(
  responses: Array<
    Response | Error | ((signal: AbortSignal) => Promise<Response>)
  >,
) {
  const calls: Array<{ url: string; body: string; signal: AbortSignal }> = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body),
      signal: init?.signal as AbortSignal,
    });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function")
      return response(init?.signal as AbortSignal);
    if (!response) throw new Error("Unexpected network call");
    return response;
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TypeSafeAdapter wire and lifecycle", () => {
  it.each(["typesafe-ai/jev", "other/decision-model"])(
    "routes %s through Vercel with gateway credentials and reported costs",
    async (model) => {
      const requests: Request[] = [];
      const replies = [choiceReply, judgeReply];
      const adapter = new TypeSafeAdapter({
        apiKey: "gateway-key",
        baseURL: "https://ai-gateway.vercel.sh/typesafe",
        model,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return json({
            ...replies.shift(),
            model,
            provider_metadata: { gateway: { cost: "0.00001155" } },
          });
        },
      });
      const selected = await adapter.choose("Buy", offered);
      const judged = await adapter.holds("Bought", {
        complete: true,
        text: "Bought",
      });
      expect(selected.selection).toEqual({ kind: "candidate", id: "a" });
      expect(selected.probabilities).toEqual({ a: 0.8, none: 0.2 });
      expect(judged).toMatchObject({ holds: 0.9, contradicted: 0.8 });
      for (const call of [selected.call, judged.call]) {
        expect(call).toMatchObject({
          requestedModel: model,
          model,
          rate: null,
          successfulResponseCostUsd: 0.00001155,
          totalCostUsd: 0.00001155,
        });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(
          "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
        );
        expect(request.headers.get("authorization")).toBe("Bearer gateway-key");
        expect(await request.json()).toMatchObject({ model });
      }
    },
  );

  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    [" ", null],
    ["invalid", null],
    ["Infinity", null],
    ["-1", null],
    ["0x10", null],
    ["0b10", null],
    ["1e2", null],
    [{}, null],
    ["0", 0],
    ["0.00001155", 0.00001155],
  ])(
    "handles optional gateway cost %j without inventing a rate",
    async (cost, expected) => {
      const transport = fake([
        json({}, 529),
        json({
          ...choiceReply,
          provider_metadata: { gateway: { cost } },
        }),
      ]);
      const adapter = new TypeSafeAdapter({
        apiKey: "gateway-key",
        baseURL: "https://ai-gateway.vercel.sh/typesafe",
        model: "typesafe-ai/jev",
        fetch: transport.fetch,
        backoffInitialMs: 1,
      });
      const selected = await adapter.choose("Buy", offered);
      expect(selected.call).toMatchObject({
        attempts: 2,
        rate: null,
        successfulResponseCostUsd: expected,
        totalCostUsd: null,
      });
    },
  );

  it.each(["typesafe/jev-1.13", "cloudflare/clef-flash"])(
    "uses OpenRouter System One for %s and preserves reported cost",
    async (model) => {
      const fetch: Fetch = async (input, init) => {
        expect(String(input)).toBe("https://openrouter.ai/api/v1/systemone");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer gateway-key",
        );
        expect(JSON.parse(String(init?.body)).model).toBe(model);
        return json({
          ...choiceReply,
          model,
          provider: "Upstream provider",
          usage: { input_tokens: 100, output_tokens: 7, cost: 0.000031 },
        });
      };
      const result = await new TypeSafeAdapter({
        apiKey: "gateway-key",
        baseURL: "https://openrouter.ai/api",
        model,
        fetch,
      }).choose("Buy", offered);
      expect(result.selection).toEqual({ kind: "candidate", id: "a" });
      expect(result.call).toMatchObject({
        provider: "openrouter",
        model,
        requestedModel: model,
        usage: { inputTokens: 100, outputTokens: 7 },
        rate: null,
        successfulResponseCostUsd: 0.000031,
        totalCostUsd: 0.000031,
      });
    },
  );

  it("keeps direct Jev pricing when gateway metadata is also present", async () => {
    const transport = fake([
      json({
        ...choiceReply,
        provider_metadata: { gateway: { cost: "16" } },
      }),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "direct-key",
      baseURL: "https://api.typesafe.ai",
      model: "jev-latest",
      fetch: transport.fetch,
    });
    const selected = await adapter.choose("Buy", offered);
    expect(selected.call.successfulResponseCostUsd).toBeCloseTo(0.0000042, 10);
    expect(selected.call.rate).not.toBeNull();
  });

  it("rejects gateway choices without probabilities", async () => {
    const transport = fake([
      json({
        ...choiceReply,
        answers: {
          target: {
            type: "choice",
            choice: "a",
            probabilities: {},
            confidence: 0,
          },
        },
      }),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "gateway-key",
      baseURL: "https://ai-gateway.vercel.sh/typesafe",
      model: "typesafe-ai/jev",
      fetch: transport.fetch,
    });
    await expect(adapter.choose("Buy", offered)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("keeps gateway retry totals unknown, including after a 429", async () => {
    const transport = fake([
      json({ error: "rate" }, 429),
      json({ ...judgeReply, usage: { ...judgeReply.usage, cost: 0.000017 } }),
    ]);
    const result = await new TypeSafeAdapter({
      apiKey: "gateway-key",
      baseURL: "https://openrouter.ai/api",
      model: "cloudflare/clef",
      fetch: transport.fetch,
      backoffInitialMs: 1,
      random: () => 0,
    }).holds("Bought", { complete: true, text: "Bought" });
    expect(result).toMatchObject({
      holds: 0.9,
      contradicted: 0.8,
      call: {
        provider: "openrouter",
        attempts: 2,
        rateLimited: true,
        rate: null,
        successfulResponseCostUsd: 0.000017,
        totalCostUsd: null,
      },
    });
  });

  it.each([0, undefined, null, -1, "0.1"])(
    "validates gateway usage.cost = %s without guessing a direct Jev rate",
    async (cost) => {
      const transport = fake([
        json({ ...judgeReply, usage: { ...judgeReply.usage, cost } }),
      ]);
      const result = new TypeSafeAdapter({
        apiKey: "gateway-key",
        baseURL: "https://openrouter.ai/api",
        fetch: transport.fetch,
      }).holds("Bought", { complete: true, text: "Bought" });
      if (cost === -1 || typeof cost === "string")
        await expect(result).rejects.toMatchObject({
          code: "invalid-response",
        });
      else
        await expect(result).resolves.toMatchObject({
          call: { rate: null, totalCostUsd: cost ?? null },
        });
    },
  );

  it("uses an explicit compatible base URL and model", async () => {
    const transport = fake([json(choiceReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "gateway-key",
      baseURL: "https://gateway.example/system-one/",
      model: "jev-compatible-model",
      fetch: transport.fetch,
    });
    const selected = await adapter.choose("Buy", offered);
    expect(transport.calls[0]?.url).toBe(
      "https://gateway.example/system-one/v1/systemone",
    );
    expect(JSON.parse(transport.calls[0]!.body).model).toBe(
      "jev-compatible-model",
    );
    expect(selected.call.requestedModel).toBe("jev-compatible-model");
    expect(selected.call.rate).toBeNull();
  });

  it("rejects unsafe provider connection settings", () => {
    expect(
      () =>
        new TypeSafeAdapter({
          apiKey: "key",
          baseURL: "http://gateway.example",
        }),
    ).toThrow(/HTTPS/);
    expect(() => new TypeSafeAdapter({ apiKey: "key", model: " " })).toThrow(
      /model/,
    );
  });

  it("reuses one client for Choice and two Noul questions and honors explicit settings", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://wrong.example");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "wrong-model");
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const transport = fake([json(choiceReply), json(judgeReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      baseURL: "https://api.typesafe.ai",
      model: "jev-latest",
      fetch: transport.fetch,
    });
    const selected = await adapter.choose("Buy SECRET-SENTENCE", offered);
    const judged = await adapter.holds("Bought", {
      complete: true,
      text: "SECRET-PAGE says Bought",
    });
    expect(selected.selection).toEqual({ kind: "candidate", id: "a" });
    expect(selected.probabilities).toEqual({ a: 0.8, none: 0.2 });
    expect(selected.call).toMatchObject({
      attempts: 1,
      requestedModel: "jev-latest",
      model: "jev-1.13.0",
      usage: { inputTokens: 100 },
    });
    expect(judged).toMatchObject({
      holds: 0.9,
      contradicted: 0.8,
      call: { attempts: 1 },
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.map((call) => call.url)).toEqual(
      Array(2).fill("https://api.typesafe.ai/v1/systemone"),
    );
    expect(transport.calls[0]!.body).toBe(
      JSON.stringify(
        buildResolverRequest("Buy SECRET-SENTENCE", offered).request,
      ),
    );
    expect(JSON.parse(transport.calls[0]!.body).model).toBe("jev-latest");
    const judgeBody = JSON.parse(transport.calls[1]!.body);
    expect(judgeBody).toMatchObject({
      model: "jev-latest",
      state: { claim: "Bought", page: "SECRET-PAGE says Bought" },
    });
    expect(Object.keys(judgeBody.questions)).toEqual(["holds", "contradicted"]);
    expect(JSON.stringify([log.mock.calls, debug.mock.calls])).not.toMatch(
      /SECRET-SENTENCE|SECRET-PAGE|test-key/,
    );
  });

  it("uses the SDK environment names when connection options are omitted", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://gateway.example/api");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "gateway-jev");
    const transport = fake([json(choiceReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "gateway-key",
      fetch: transport.fetch,
    });
    const selected = await adapter.choose("Buy", offered);
    expect(transport.calls[0]?.url).toBe(
      "https://gateway.example/api/v1/systemone",
    );
    expect(JSON.parse(transport.calls[0]!.body).model).toBe("gateway-jev");
    expect(selected.call.requestedModel).toBe("gateway-jev");
  });

  it("returns none unchanged and prevents network calls on rejected input", async () => {
    const transport = fake([
      json({
        ...choiceReply,
        answers: {
          target: {
            type: "choice",
            choice: "none",
            probabilities: { a: 0.1, none: 0.9 },
          },
        },
      }),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
    });
    await expect(
      adapter.choose("Buy", { ...offered, complete: false }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(transport.calls).toHaveLength(0);
    await expect(adapter.choose("Buy", offered)).resolves.toMatchObject({
      selection: { kind: "none" },
    });
  });

  it("retries 429 and 529, then reports unknown total cost", async () => {
    const transport = fake([
      json({ error: "rate" }, 429),
      json({ error: "busy" }, 529),
      json(choiceReply),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      backoffInitialMs: 1,
    });
    const result = await adapter.choose("Buy", offered);
    expect(transport.calls).toHaveLength(3);
    expect(result.call).toMatchObject({
      attempts: 3,
      rateLimited: true,
      totalCostUsd: null,
    });
    expect(result.call.successfulResponseCostUsd).toBeCloseTo(0.0000042);
  });

  it.each([
    [401, "authentication", "Model provider authentication failed."],
    [403, "authentication", "Model provider authentication failed."],
    [
      402,
      "configuration",
      "The model provider account has no available API credits.",
    ],
    [400, "invalid-input", "The model provider rejected the request."],
    [499, "invalid-input", "The model provider rejected the request."],
    [500, "connection", "The model provider could not complete the request."],
    [528, "connection", "The model provider could not complete the request."],
    [530, "connection", "The model provider could not complete the request."],
  ] as const)(
    "converts HTTP %i to the stable %s provider error",
    async (status, code, message) => {
      const transport = fake([json({ detail: "SECRET-ERROR-BODY" }, status)]);
      await expect(
        new TypeSafeAdapter({
          apiKey: "test-key",
          fetch: transport.fetch,
        }).choose("Buy", offered),
      ).rejects.toMatchObject({ code, message, attempts: 1 });
      expect(transport.calls).toHaveLength(1);
    },
  );

  it("maps every ordinary 4xx status to invalid-input without leaking its body", async () => {
    const exceptionalStatuses = new Set([401, 402, 403, 429]);
    for (let status = 400; status < 500; status++) {
      if (exceptionalStatuses.has(status)) continue;
      const transport = fake([json({ detail: `secret-${status}` }, status)]);
      const error = await new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: transport.fetch,
      })
        .choose("Buy", offered)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "invalid-input",
        message: "The model provider rejected the request.",
        attempts: 1,
      });
      expect(JSON.stringify(error)).not.toContain(`secret-${status}`);
      expect(transport.calls).toHaveLength(1);
    }
  });

  it("retries a connection failure and exhausts after three calls", async () => {
    const transport = fake([
      new Error("secret connection detail"),
      new Error("second"),
      new Error("third"),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      backoffInitialMs: 1,
    });
    await expect(adapter.choose("Buy", offered)).rejects.toMatchObject({
      code: "retry-exhausted",
      attempts: 3,
    });
    expect(transport.calls).toHaveLength(3);
  });

  it("retries an SDK attempt timeout and succeeds within the overall deadline", async () => {
    const timeout = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("attempt timed out")),
          { once: true },
        );
      });
    const transport = fake([timeout, json(choiceReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      attemptTimeoutMs: 10,
      deadlineMs: 1000,
      backoffInitialMs: 1,
    });
    const result = await adapter.choose("Buy", offered);
    expect(result.call.attempts).toBe(2);
    expect(transport.calls).toHaveLength(2);
  });

  it("does not retry authentication or a malformed successful reply", async () => {
    const denied = fake([json({ detail: "SECRET-ERROR-BODY" }, 401)]);
    await expect(
      new TypeSafeAdapter({ apiKey: "test-key", fetch: denied.fetch }).choose(
        "Buy",
        offered,
      ),
    ).rejects.toMatchObject({ code: "authentication", attempts: 1 });
    expect(denied.calls).toHaveLength(1);
    const unpaid = fake([json({ detail: "billing_error" }, 402)]);
    await expect(
      new TypeSafeAdapter({ apiKey: "test-key", fetch: unpaid.fetch }).choose(
        "Buy",
        offered,
      ),
    ).rejects.toMatchObject({
      code: "configuration",
      message: "The model provider account has no available API credits.",
      attempts: 1,
    });
    const bad = fake([
      json({
        ...choiceReply,
        answers: {
          target: {
            type: "choice",
            choice: "a",
            probabilities: { a: 2, none: -1 },
          },
        },
      }),
    ]);
    await expect(
      new TypeSafeAdapter({ apiKey: "test-key", fetch: bad.fetch }).choose(
        "Buy",
        offered,
      ),
    ).rejects.toMatchObject({
      code: "invalid-response",
      failedCall: {
        model: "jev-1.13.0",
        usage: { inputTokens: 100, outputTokens: 0 },
      },
    });
    expect(bad.calls).toHaveLength(1);
    const missingJudge = fake([
      json({ ...judgeReply, answers: { holds: { type: "noul", noul: 0.5 } } }),
    ]);
    await expect(
      new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: missingJudge.fetch,
      }).holds("Bought", { complete: true, text: "Bought" }),
    ).rejects.toMatchObject({
      code: "invalid-response",
      failedCall: {
        model: "jev-1.13.0",
        usage: { inputTokens: 200, outputTokens: 0 },
      },
    });
    expect(missingJudge.calls).toHaveLength(1);
  });

  it("enforces the overall deadline and caller cancellation", async () => {
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const deadline = fake([waitForAbort]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: deadline.fetch,
      deadlineMs: 10,
      attemptTimeoutMs: 100,
    });
    await expect(adapter.choose("Buy", offered)).rejects.toMatchObject({
      code: "timeout",
      attempts: 1,
    });
    const caller = new AbortController();
    const canceled = fake([waitForAbort]);
    const pending = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: canceled.fetch,
    }).choose("Buy", offered, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps public error serialization free of provider details", () => {
    const error = new ProviderError(
      "authentication",
      "TypeSafe authentication failed.",
      1,
    );
    expect(JSON.stringify(error)).toBe(
      '{"code":"authentication","message":"TypeSafe authentication failed.","attempts":1}',
    );
    expect(() => new TypeSafeAdapter({ apiKey: " " })).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });
});

describe("TypeSafeAdapter screenshots", () => {
  // Bytes chosen so a wrong encoding (hex, utf8, a data: prefix) differs.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xfa]);
  const digest = { complete: true, text: "Cart 1", screenshot: jpeg };

  function recorder(replies: Response[]) {
    // Request bodies are inspected loosely; their shape is what is asserted.
    type Body = {
      model: string;
      state: Record<string, string>;
      assets: Record<string, unknown>;
      questions: Record<
        string,
        { instructions: string; criteria: Record<string, string> }
      >;
    };
    const requests: { headers: Headers; body: Body }[] = [];
    const adapter = new TypeSafeAdapter({
      apiKey: "key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          headers: request.headers,
          body: (await request.json()) as Body,
        });
        return replies.shift() ?? json({}, 500);
      },
    });
    return { adapter, requests };
  }

  it("sends the Judge screenshot as an asset with the images header and image model", async () => {
    const { adapter, requests } = recorder([
      json({ ...judgeReply, model: "jev-1.14.0" }),
      json(judgeReply),
    ]);
    const judged = await adapter.holds("The badge is red", digest);
    await adapter.holds("The badge is red", { complete: true, text: "Cart 1" });

    const [withImage, textOnly] = requests;
    const ref = withImage!.body.state.screen!;
    expect(withImage!.headers.get("typesafe-danger-zone-images")).toBe("true");
    expect(withImage!.body).toMatchObject({
      model: "jev-1.14.0",
      state: { claim: "The badge is red", page: "Cart 1", screen: ref },
      assets: {
        [ref]: { type: "image", format: "jpg", data_base64: "/9j/4AAQ+g==" },
      },
    });
    expect(Object.keys(withImage!.body.assets)).toEqual([ref]);
    expect(judged.call.requestedModel).toBe("jev-1.14.0");
    // Without a screenshot nothing about the text request changes.
    expect(textOnly!.headers.get("typesafe-danger-zone-images")).toBeNull();
    expect(textOnly!.body.model).toBe("jev-latest");
    expect(textOnly!.body).not.toHaveProperty("assets");
  });

  it("judges from text and stops sending images after the service rejects one", async () => {
    const { adapter, requests } = recorder([
      json({ detail: { error_type: "api_usage_error" } }, 400),
      json(judgeReply),
      json(judgeReply),
    ]);
    const first = await adapter.holds("The badge is red", digest);
    await adapter.holds("The badge is red", digest);

    expect(first).toMatchObject({ holds: 0.9, contradicted: 0.8 });
    expect(requests.map((request) => "assets" in request.body)).toEqual([
      true,
      false,
      false,
    ]);
    await expect(
      adapter.checkTarget({
        sentence: "click Add",
        operation: "click",
        image: jpeg,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(requests).toHaveLength(3);
  });

  it("reads the pick check's several probability and match score", async () => {
    const { adapter, requests } = recorder([
      json({
        answers: {
          match: { type: "noul", noul: 0.97 },
          count: {
            type: "choice",
            choice: "several",
            probabilities: { none: 0.05, one: 0.3, several: 0.65 },
          },
        },
        model: "jev-1.14.0",
        usage: { input_tokens: 3000, output_tokens: 0 },
      }),
    ]);
    const decision = await adapter.checkTarget({
      sentence: "click Add to cart",
      operation: "fill",
      image: jpeg,
    });

    expect(decision).toMatchObject({ match: 0.97, several: 0.65 });
    expect(decision.call).toMatchObject({ requestedModel: "jev-1.14.0" });
    const [request] = requests;
    expect(request!.headers.get("typesafe-danger-zone-images")).toBe("true");
    expect(request!.body.questions.count!.instructions).toContain(
      'type into to do this browser-test step: "click Add to cart"',
    );
    expect(Object.keys(request!.body.questions.count!.criteria)).toEqual([
      "none",
      "one",
      "several",
    ]);
  });

  describe("vision fallback", () => {
    const observation = {
      instruction: "click Edit for Alan",
      image: jpeg,
      candidates: [
        { id: "C1", name: "Edit", role: "button" },
        { id: "C2", name: "Edit", role: "button" },
      ],
    };
    const reply = (
      target: Record<string, number>,
      count: Record<string, number>,
    ) =>
      json({
        answers: {
          target: {
            type: "choice",
            choice: Object.entries(target).sort((a, b) => b[1] - a[1])[0]![0],
            probabilities: target,
          },
          count: {
            type: "choice",
            choice: Object.entries(count).sort((a, b) => b[1] - a[1])[0]![0],
            probabilities: count,
          },
        },
        model: "jev-1.14.0",
        usage: { input_tokens: 3400, output_tokens: 0 },
      });
    const target = (c2: number) => ({
      C1: 0.98 - c2,
      C2: c2,
      ambiguous: 0.01,
      no_match: 0.01,
    });
    const one = { none: 0.05, one: 0.9, several: 0.05 };

    it("asks Jev to choose among the labelled boxes from the screenshot", async () => {
      const { adapter, requests } = recorder([reply(target(0.95), one)]);
      const answer = await adapter.chooseFromScreenshot(observation);

      expect(answer.decision).toEqual({ kind: "candidate", id: "C2" });
      expect(answer.call).toMatchObject({ requestedModel: "jev-1.14.0" });
      const [request] = requests;
      const ref = request!.body.state.screen!;
      expect(request!.headers.get("typesafe-danger-zone-images")).toBe("true");
      expect(request!.body).toMatchObject({
        model: "jev-1.14.0",
        assets: {
          [ref]: { type: "image", format: "png", data_base64: "/9j/4AAQ+g==" },
        },
      });
      expect(Object.keys(request!.body.questions.target!.criteria)).toEqual([
        "C1",
        "C2",
        "ambiguous",
        "no_match",
      ]);
      expect(request!.body.questions.target!.instructions).toContain(
        '"click Edit for Alan"',
      );
    });

    it("does not share the image rejection latch with the Judge and target check", async () => {
      const rejected = () =>
        json({ detail: { error_type: "api_usage_error" } }, 400);
      const judgeFirst = recorder([
        rejected(),
        json(judgeReply),
        reply(target(0.95), one),
      ]);
      await judgeFirst.adapter.holds("The badge is red", digest);
      expect(
        await judgeFirst.adapter.chooseFromScreenshot(observation),
      ).toMatchObject({ decision: { kind: "candidate", id: "C2" } });
      expect(judgeFirst.requests.map((r) => "assets" in r.body)).toEqual([
        true,
        false,
        true,
      ]);

      const visionFirst = recorder([rejected(), json(judgeReply)]);
      await expect(
        visionFirst.adapter.chooseFromScreenshot(observation),
      ).rejects.toMatchObject({ code: "invalid-input" });
      await visionFirst.adapter.holds("The badge is red", digest);
      expect(visionFirst.requests.map((r) => "assets" in r.body)).toEqual([
        true,
        true,
      ]);
    });

    it("abstains unless Jev is sure of the box and that something fits", async () => {
      const { adapter } = recorder([
        reply(target(0.85), one),
        reply(target(0.95), { none: 0.35, one: 0.6, several: 0.05 }),
        reply(target(0.95), { none: 0.05, one: 0.4, several: 0.55 }),
        reply({ C1: 0.1, C2: 0.1, ambiguous: 0.7, no_match: 0.1 }, one),
      ]);
      const reasons = [];
      for (let index = 0; index < 4; index++)
        reasons.push(
          (await adapter.chooseFromScreenshot(observation)).decision,
        );
      expect(reasons).toEqual([
        { kind: "abstain", reason: "uncertain" },
        { kind: "abstain", reason: "no_match" },
        { kind: "abstain", reason: "ambiguous" },
        { kind: "abstain", reason: "ambiguous" },
      ]);
    });
  });
});
