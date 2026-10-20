import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  symlink,
  chmod,
  realpath,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

let root: string;
let origin: string;
let errors: string[];
let verification: string | undefined;
let email: string | null;
let organizations: {
  id: string;
  name: string;
  role: string;
  projects: { id: string; name: string }[];
}[];
let seen: { url: string; body: URLSearchParams; authorization?: string }[];
let redirect: boolean;
let expiresIn: number;
let retryAfter: string;
let credentialSuffix: string;
let tokenStatus: number;
let meFailures: number;
let hangToken: boolean;
let pollSeconds: number;
let deviceSentAt: number;
let pollTimes: number[];
let server: ReturnType<typeof createServer>;
beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(tmpdir()), "sedum-auth-"));
  errors = [];
  seen = [];
  verification = undefined;
  email = "user@example.test";
  redirect = false;
  expiresIn = 30;
  retryAfter = "0";
  credentialSuffix = "";
  tokenStatus = 200;
  meFailures = 0;
  hangToken = false;
  pollSeconds = 0.001;
  deviceSentAt = 0;
  pollTimes = [];
  organizations = [
    {
      id: "org",
      name: "Team",
      role: "owner",
      projects: [{ id: "project", name: "App" }],
    },
  ];
  server = createServer(respond);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
});
async function respond(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  seen.push({
    url: req.url!,
    body: new URLSearchParams(body),
    ...(req.headers.authorization
      ? { authorization: req.headers.authorization }
      : {}),
  });
  res.setHeader("content-type", "application/json");
  res.setHeader("retry-after", retryAfter);
  if (redirect) {
    res.writeHead(302, { location: `${origin}/stolen` });
    res.end();
    return;
  }
  if (req.url === "/api/oauth/device/code") {
    deviceSentAt = performance.now();
    res.end(
      JSON.stringify({
        device_code: "secret-device",
        user_code: "ABCD-EFGH",
        verification_uri: verification ?? `${origin}/activate`,
        verification_uri_complete:
          verification ?? `${origin}/activate?user_code=ABCD-EFGH`,
        expires_in: expiresIn,
        interval: pollSeconds,
      }),
    );
  } else if (req.url === "/api/oauth/token") respondToken(res);
  else if (req.url === "/api/auth/me") {
    if (meFailures-- > 0) {
      res.writeHead(401);
      res.end("not JSON secret-server");
      return;
    }
    res.end(
      JSON.stringify({
        user: { id: "user", name: "User", email },
        organizations,
      }),
    );
  } else {
    res.statusCode = 204;
    res.end();
  }
}
function respondToken(res: ServerResponse) {
  pollTimes.push(performance.now());
  if (hangToken) return;
  if (tokenStatus !== 200) {
    res.writeHead(tokenStatus, { "retry-after": "1" });
    res.end("not JSON secret-server");
    return;
  }
  const error = errors.shift();
  if (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error, error_description: "secret-server" }));
    return;
  }
  res.end(
    JSON.stringify({
      token_type: "Bearer",
      access_token: `secret-access${credentialSuffix}`,
      refresh_token: `secret-refresh${credentialSuffix}`,
      expires_in: 900,
    }),
  );
}
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
function cli(args: string[], signal?: AbortSignal) {
  return runCli(["auth", ...args], "test", {
    auth: { configDirectory: path.join(root, "config") },
    ...(signal ? { signal } : {}),
  });
}
const login = () => cli(["login", "--url", origin, "--no-browser"]);

it("approves after pending, persists secure credentials, refreshes, validates membership and revokes", async () => {
  errors = ["authorization_pending"];
  const result = await login();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ABCD-EFGH");
  expect(JSON.stringify(result)).not.toContain("secret-");
  expect(seen[0]!.body.get("client_id")).toBe("sedum-cli");
  const file = path.join(root, "config/auth.json");
  if (process.platform !== "win32")
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  const state = JSON.parse(await readFile(file, "utf8"));
  state.sessions[origin].expiresAt = 0;
  await writeFile(file, JSON.stringify(state));
  credentialSuffix = "-rotated";
  expect((await cli(["status"])).exitCode).toBe(0);
  expect(seen.some((r) => r.body.get("grant_type") === "refresh_token")).toBe(
    true,
  );
  expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-rotated");
  expect(
    JSON.parse(await readFile(file, "utf8")).sessions[origin].refresh_token,
  ).toBe("secret-refresh-rotated");
  expect((await cli(["status"])).exitCode).toBe(0);
  expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-rotated");
  expect((await cli(["logout"])).exitCode).toBe(0);
  expect(seen.at(-1)?.body.get("token")).toBe("secret-refresh-rotated");
  expect(await readFile(file, "utf8")).not.toContain("secret-");
});
it.each(["access_denied", "expired_token", "invalid_grant"])(
  "handles %s without exposing server details",
  async (error) => {
    errors = [error];
    const result = await login();
    expect(result.exitCode).toBe(3);
    expect(JSON.stringify(result)).not.toContain("secret-");
  },
);
it("logs in when GitHub does not expose an email address", async () => {
  email = null;
  const result = await login();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('as "User"');
});
it("replaces login without leaving the previous remote session active", async () => {
  await login();
  credentialSuffix = "-next";
  const result = await login();
  expect(result.exitCode).toBe(0);
  const revocation = seen.find((r) => r.url === "/api/oauth/revoke");
  expect(revocation?.body.get("token")).toBe("secret-refresh");
  expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-next");
  const state = JSON.parse(
    await readFile(path.join(root, "config/auth.json"), "utf8"),
  );
  expect(state.sessions[origin].refresh_token).toBe("secret-refresh-next");
});
it("honors slow_down and permits cancellation during its wait", async () => {
  errors = ["slow_down"];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = await cli(
    ["login", "--url", origin, "--no-browser"],
    controller.signal,
  );
  clearTimeout(timer);
  expect(result.stderr).toContain("cancelled");
  expect(seen.filter((r) => r.url === "/api/oauth/token")).toHaveLength(1);
});
it.each([
  "https://evil.example/activate",
  "http://user:secret@127.0.0.1/activate",
])("rejects malicious verification %s", async (url) => {
  verification = url;
  const result = await login();
  expect(result.stderr).toContain("unsafe verification");
  expect(seen).toHaveLength(1);
});
it("rejects redirects and does not follow them", async () => {
  redirect = true;
  expect((await login()).exitCode).toBe(3);
  expect(seen).toHaveLength(1);
});
it("isolates instances and rejects insecure remote URLs", async () => {
  await login();
  const count = seen.length;
  expect(
    (await cli(["status", "--url", "https://other.example"])).stderr,
  ).toContain("Not logged in");
  expect(
    (await cli(["login", "--url", "http://remote.example"])).exitCode,
  ).toBe(3);
  expect(seen).toHaveLength(count);
});
it("handles zero organizations and rejects noninteractive ambiguous choices while keeping account login", async () => {
  organizations = [];
  expect((await login()).stdout).toContain("Account login saved");
  organizations = [1, 2].map((id) => ({
    id: String(id),
    name: "Duplicate",
    role: "member",
    projects: [],
  }));
  expect((await cli(["status"])).stderr).toContain("Multiple organization");
  expect((await cli(["status", "--organization", "Duplicate"])).exitCode).toBe(
    3,
  );
  expect((await cli(["status", "--organization", "2"])).exitCode).toBe(0);
});
it("rejects symlink credential files", async () => {
  await login();
  const file = path.join(root, "config/auth.json");
  const target = path.join(root, "target");
  await writeFile(target, await readFile(file));
  await rm(file);
  await symlink(target, file);
  expect((await cli(["status"])).stderr).toContain("Unsafe credential file");
});

it("expires locally without polling early when Retry-After exceeds device lifetime", async () => {
  expiresIn = 0.02;
  retryAfter = "1";
  const result = await login();
  expect(result.stderr).toContain("expired");
  expect(seen).toHaveLength(1);
});
it("refuses unsafe permissions and concurrent auth ownership", async () => {
  await login();
  const file = path.join(root, "config/auth.json");
  if (process.platform !== "win32") {
    await chmod(file, 0o644);
    expect((await cli(["status"])).stderr).toContain("Unsafe credential file");
    await chmod(file, 0o600);
  }
  await writeFile(path.join(root, "config/auth.lock"), "", { mode: 0o600 });
  expect((await cli(["status"])).stderr).toContain("locked");
});
it("warns on unconfirmed revocation but still removes local credentials", async () => {
  await login();
  redirect = true;
  const result = await cli(["logout"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("revocation could not be confirmed");
  expect(
    await readFile(path.join(root, "config/auth.json"), "utf8"),
  ).not.toContain("secret-");
});
it("supports interactive choices through runCli and validates project names", async () => {
  organizations[0]!.projects.push({ id: "second", name: "Second" });
  const result = await runCli(
    ["auth", "login", "--url", origin, "--no-browser"],
    "test",
    {
      auth: {
        configDirectory: path.join(root, "config"),
        choose: async () => "second",
      },
    },
  );
  expect(result.stdout).toContain("Second");
  expect((await cli(["status", "--project", "App"])).stdout).toContain("App");
});

it("refuses credential storage inside a Git checkout", async () => {
  await writeFile(path.join(root, ".git"), "gitdir: /unused");
  expect((await login()).stderr).toContain("outside a Git checkout");
  expect(seen).toHaveLength(0);
});

it("does not mislabel callback failures as storage errors or expose details", async () => {
  organizations[0]!.projects.push({ id: "second", name: "Second" });
  const result = await runCli(
    ["auth", "login", "--url", origin, "--no-browser"],
    "test",
    {
      auth: {
        configDirectory: path.join(root, "config"),
        choose: async () => {
          throw new Error("secret-bug");
        },
      },
    },
  );
  expect(result.stderr).toContain("Authentication failed safely");
  expect(result.stderr).not.toContain("storage");
  expect(result.stderr).not.toContain("secret-bug");
  expect((await cli(["status", "--project", "project"])).exitCode).toBe(0);
});

it("backs off non-JSON rate limits until local expiry", async () => {
  tokenStatus = 429;
  expiresIn = 0.1;
  expect((await login()).stderr).toContain("expired");
  expect(seen.filter((r) => r.url === "/api/oauth/token")).toHaveLength(1);
});

it("does not poll before the monotonic interval boundary", async () => {
  pollSeconds = 0.025;
  errors = ["authorization_pending"];
  expect((await login()).exitCode).toBe(0);
  expect(seen.filter((r) => r.url === "/api/oauth/token")).toHaveLength(2);
  expect(pollTimes[0]! - deviceSentAt).toBeGreaterThanOrEqual(25);
  expect(pollTimes[1]! - pollTimes[0]!).toBeGreaterThanOrEqual(25);
});

it("reports device expiry, not cancellation, for an in-flight poll", async () => {
  hangToken = true;
  expiresIn = 0.1;
  expect((await login()).stderr).toContain("Device login expired");
  expect(seen.filter((r) => r.url === "/api/oauth/token")).toHaveLength(1);
  hangToken = false;
  expect((await login()).exitCode).toBe(0);
});

it("refreshes on non-JSON membership 401 once and persists the rotated pair", async () => {
  await login();
  credentialSuffix = "-new";
  meFailures = 1;
  expect((await cli(["status"])).exitCode).toBe(0);
  expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-new");
  expect((await cli(["logout"])).exitCode).toBe(0);
  expect(seen.at(-1)?.body.get("token")).toBe("secret-refresh-new");
});

it("never loops refresh when membership keeps rejecting access", async () => {
  await login();
  seen = [];
  meFailures = 3;
  expect((await cli(["status"])).exitCode).toBe(3);
  expect(seen.map((r) => r.url)).toEqual([
    "/api/auth/me",
    "/api/oauth/token",
    "/api/auth/me",
  ]);
});

it("keeps concurrent ownership until cancellation and then releases it", async () => {
  hangToken = true;
  const controller = new AbortController();
  const pending = cli(
    ["login", "--url", origin, "--no-browser"],
    controller.signal,
  );
  while (!seen.some((r) => r.url === "/api/oauth/token"))
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect((await cli(["status"])).stderr).toContain("locked");
  controller.abort();
  expect((await pending).stderr).toContain("cancelled");
  hangToken = false;
  expect((await login()).exitCode).toBe(0);
});

it("keeps two origins and logs out only the requested instance", async () => {
  await login();
  const first = origin;
  // Use a second loopback listener rather than relying on localhost DNS order.
  const second = createServer(respond);
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  const address = second.address();
  if (!address || typeof address === "string") throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  try {
    credentialSuffix = "-second";
    expect((await login()).exitCode).toBe(0);
    const file = path.join(root, "config/auth.json");
    expect(
      Object.keys(JSON.parse(await readFile(file, "utf8")).sessions),
    ).toHaveLength(2);
    expect((await cli(["logout", "--url", first])).exitCode).toBe(0);
    expect(seen.at(-1)?.body.get("token")).toBe("secret-refresh");
    expect((await cli(["status", "--url", origin])).exitCode).toBe(0);
    expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-second");
  } finally {
    second.closeAllConnections();
    await new Promise<void>((resolve) => second.close(() => resolve()));
  }
});

it.skipIf(process.platform === "win32").each(["\u0003", "\u0004"])(
  "settles the real terminal chooser on %j and releases its lock",
  async (key) => {
    await login();
    organizations[0]!.projects.push({ id: "second", name: "Second" });
    const file = path.join(root, "config/auth.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.selections = {};
    await writeFile(file, JSON.stringify(state));
    await rename(path.join(root, "config"), path.join(root, "sedum"));
    const child = spawn(
      "python3",
      [
        "-c",
        `
import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
output = b""
sent = False
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        output += chunk
        if b"Select project number:" in output and not sent:
            os.write(fd, ${JSON.stringify(key)}.encode())
            sent = True
else:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`,
        process.execPath,
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "auth",
        "status",
      ],
      {
        env: { ...process.env, XDG_CONFIG_HOME: root },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(3);
    expect(output).toContain("Authentication cancelled");
    await expect(
      stat(path.join(root, "sedum/auth.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rename(path.join(root, "sedum"), path.join(root, "config"));
    expect((await cli(["status", "--project", "project"])).exitCode).toBe(0);
  },
  15_000,
);
