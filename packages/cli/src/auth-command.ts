import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  AuthError,
  cloudOrigin,
  membershipSchema,
  parse,
  request,
  tokenResult,
  type Tokens,
} from "./auth-api.js";
import { withAuthStore, type AuthState } from "./auth-store.js";

export interface AuthOptions {
  url?: string;
  organization?: string;
  project?: string;
  browser?: boolean;
}
type Choice = { id: string; name: string };
export interface AuthRuntime {
  configDirectory?: string;
  choose?: (
    kind: string,
    choices: readonly Choice[],
    signal: AbortSignal,
  ) => Promise<string>;
  openBrowser?: (url: string) => void;
}
interface Context {
  options: AuthOptions;
  runtime: AuthRuntime;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  signal: AbortSignal;
}
interface Store {
  state: AuthState;
  save: () => Promise<void>;
  origin: string;
}

function openBrowser(url: URL) {
  // No shell; the URL is one argument, never a command string.
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const child = spawn(
    command,
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", url.href]
      : [url.href],
    { stdio: "ignore", shell: false },
  );
  child.on("error", () => {});
  child.unref();
}

function verification(url: URL, origin: string): URL {
  try {
    if (url.origin !== origin) throw new Error();
    if ([url.username, url.password, url.hash].some(Boolean)) throw new Error();
    return url;
  } catch {
    throw new AuthError(
      "Cloud returned an unsafe verification URL; login stopped.",
    );
  }
}

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z
    .string()
    .min(1)
    .regex(/^[\w -]+$/),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().positive().max(600),
  interval: z.number().positive().max(600),
});

function showActivation(
  device: z.infer<typeof deviceSchema>,
  origin: string,
  context: Context,
) {
  const activation = verification(new URL(device.verification_uri), origin);
  const complete = verification(
    new URL(device.verification_uri_complete),
    origin,
  );
  context.write(
    `Open ${activation}\nEnter code: ${device.user_code}\nWaiting for browser approval. Press Ctrl-C to cancel.\n`,
  );
  if (context.options.browser === false) return;
  try {
    if (context.runtime.openBrowser) context.runtime.openBrowser(complete.href);
    else openBrowser(complete);
  } catch {
    /* Printed instructions remain usable. */
  }
}

function pollInterval(
  result: Awaited<ReturnType<typeof request>>,
  interval: number,
): number {
  if (result.status === 429) return Math.max(interval, result.retryMs);
  const error = parse(z.object({ error: z.string() }), result.body).error;
  if (result.status !== 400)
    throw new AuthError(
      "Cloud rejected device login. Start `sedum auth login` again.",
    );
  if (error === "authorization_pending") return interval;
  if (error === "slow_down") return interval + 5000;
  throw deviceFailure(error);
}
function deviceFailure(error: string): AuthError {
  if (error === "access_denied")
    return new AuthError("Login was denied in the browser.");
  if (["expired_token", "invalid_grant"].includes(error)) return expired();
  return new AuthError(
    "Cloud rejected device login. Start `sedum auth login` again.",
  );
}
function expired() {
  return new AuthError("Device login expired. Run `sedum auth login` again.");
}

async function deviceLogin(origin: string, context: Context) {
  const response = await request(
    origin,
    "/api/oauth/device/code",
    context.signal,
    { form: {} },
  );
  if (!response.ok)
    throw new AuthError(
      "Cloud could not start device login. Check the instance configuration.",
    );
  const device = parse(deviceSchema, response.body);
  showActivation(device, origin, context);
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  let delay = Math.max(interval, response.retryMs);
  while (Date.now() < deadline) {
    await sleep(Math.min(delay, deadline - Date.now()), undefined, {
      signal: context.signal,
    });
    if (Date.now() >= deadline) break;
    const result = await pollDevice(
      { origin, deadline, deviceCode: device.device_code },
      context,
    );
    if (result.ok) return tokenResult(result.body);
    interval = pollInterval(result, interval);
    delay = Math.max(interval, result.retryMs);
  }
  throw expired();
}

function pollDevice(
  device: { origin: string; deadline: number; deviceCode: string },
  context: Context,
) {
  const remaining = Math.max(1, Math.ceil(device.deadline - Date.now()));
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(remaining),
  ]);
  return request(device.origin, "/api/oauth/token", signal, {
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
    },
  });
}

function explicitChoice<T extends Choice>(
  kind: string,
  choices: T[],
  value: string,
): T {
  const ids = choices.filter((item) => item.id === value);
  const matches = ids.length
    ? ids
    : choices.filter((item) => item.name === value);
  if (matches.length !== 1)
    throw new AuthError(
      `--${kind} must match a current ID or unambiguous name.`,
    );
  return matches[0]!;
}
async function select<T extends Choice>(
  kind: "organization" | "project",
  choices: T[],
  previous: string | undefined,
  context: Context,
): Promise<T | undefined> {
  const explicit = context.options[kind];
  if (explicit) return explicitChoice(kind, choices, explicit);
  const found = choices.find((item) => item.id === previous);
  if (found) return found;
  if (choices.length <= 1) return choices[0];
  if (!context.runtime.choose)
    throw new AuthError(
      `Multiple ${kind} choices. Rerun with --${kind} <ID or unambiguous name>.`,
    );
  const id = await context.runtime.choose(kind, choices, context.signal);
  return explicitChoice(kind, choices, id);
}

async function logout(store: Store, context: Context) {
  const session = store.state.sessions[store.origin];
  if (session && !(await revoke(store, session, context)))
    context.writeErr(
      "Warning: remote revocation could not be confirmed. Local credentials removed; the remote session may remain active until its 30-day expiry.\n",
    );
  delete store.state.sessions[store.origin];
  delete store.state.selections[store.origin];
  await store.save();
  context.write("Logged out locally.\n");
}
async function revoke(store: Store, session: Tokens, context: Context) {
  try {
    const result = await request(
      store.origin,
      "/api/oauth/revoke",
      context.signal,
      {
        form: { token: session.refresh_token },
      },
    );
    return result.ok;
  } catch {
    return false;
  }
}

async function login(store: Store, context: Context) {
  const previous = store.state.sessions[store.origin];
  const next = await deviceLogin(store.origin, context);
  store.state.sessions[store.origin] = next;
  store.state.selectedOrigin = store.origin;
  await store.save(); // Account login survives absent/ambiguous project choices.
  if (previous && !(await revoke(store, previous, context)))
    context.writeErr(
      "Warning: your previous CLI session could not be revoked and may remain active until its 30-day expiry. The new login is saved.\n",
    );
}

async function currentSession(store: Store, context: Context) {
  const session = store.state.sessions[store.origin];
  if (!session)
    throw new AuthError(
      "Not logged in to this instance. Run `sedum auth login`.",
    );
  if (session.expiresAt > Date.now()) return session;
  const refreshed = await request(
    store.origin,
    "/api/oauth/token",
    context.signal,
    {
      form: {
        grant_type: "refresh_token",
        refresh_token: session.refresh_token,
      },
    },
  );
  if (!refreshed.ok)
    throw new AuthError(
      "Session could not be refreshed. Run `sedum auth login` again.",
    );
  const next = tokenResult(refreshed.body);
  store.state.sessions[store.origin] = next;
  await store.save();
  return next;
}

async function status(store: Store, context: Context) {
  const session = await currentSession(store, context);
  const response = await request(store.origin, "/api/auth/me", context.signal, {
    access: session.access_token,
  });
  if (!response.ok)
    throw new AuthError(
      "Cloud could not validate this session or current membership. Run `sedum auth login` again.",
    );
  const me = parse(membershipSchema, response.body);
  const previous = store.state.selections[store.origin];
  // Clear stale selections before prompting or reporting a selection error.
  delete store.state.selections[store.origin];
  await store.save();
  context.write(
    `Signed in to ${store.origin} as ${JSON.stringify(me.user.email ?? me.user.name ?? me.user.id)}.\n`,
  );
  const organization = await select(
    "organization",
    me.organizations,
    previous?.organization,
    context,
  );
  const project = await select(
    "project",
    organization?.projects ?? [],
    previous?.project,
    context,
  );
  store.state.selections[store.origin] = {
    organization: organization?.id,
    project: project?.id,
  };
  store.state.selectedOrigin = store.origin;
  await store.save();
  showSelection(organization, project, context);
}

function showSelection(
  organization: Choice | undefined,
  project: Choice | undefined,
  context: Context,
) {
  if (!organization || !project) {
    context.write(
      "Account login saved. Open your Cloud instance to create or join an organization and create a project, then run `sedum auth status`.\n",
    );
    return;
  }
  context.write(
    `Organization: ${JSON.stringify(organization.name)} (${JSON.stringify(organization.id)})\nProject: ${JSON.stringify(project.name)} (${JSON.stringify(project.id)})\n`,
  );
}

async function authenticate(command: string, context: Context) {
  return withAuthStore(context.runtime.configDirectory, async (state, save) => {
    const configured =
      context.options.url ??
      process.env.SEDUM_CLOUD_URL ??
      state.selectedOrigin;
    if (!configured)
      throw new AuthError(
        "No Cloud instance selected. Use `sedum auth login --url <your Cloud origin>` or set SEDUM_CLOUD_URL.",
      );
    const origin = cloudOrigin(configured);
    const store = { state, save, origin };
    if (command === "logout") return logout(store, context);
    if (command === "login") await login(store, context);
    await status(store, context);
  });
}

export async function executeAuthCommand(
  command: string,
  context: Omit<Context, "signal">,
  externalSignal?: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  try {
    await authenticate(command, { ...context, signal });
    return 0;
  } catch (error) {
    context.writeErr(`${authMessage(error, signal)}\n`);
    return 3;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
function authMessage(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "Authentication cancelled.";
  if (error instanceof AuthError) return error.message;
  return "Authentication failed safely; no server error details were printed.";
}
