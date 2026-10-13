/**
 * Bug-detector fixture pages: planted browser faults of each kind and clean
 * controls, with their labels. Labels name the checks a case must raise on
 * its load step and, after clicking `#act`, on its action step.
 */
export type DetectorLabel =
  "console_error" | "uncaught_exception" | "unhandled_rejection" | "http_error";

export interface DetectorCase {
  readonly id: string;
  readonly expect: {
    readonly load: readonly DetectorLabel[];
    readonly action?: readonly DetectorLabel[];
  };
  readonly status?: number;
  readonly title: string;
  readonly body: string;
  readonly script?: string;
}

const NAV = `<header><strong>Acme Store</strong> <nav><a href="/detector/clean-products">Shop</a> <a href="/detector/clean-orders">Orders</a> <a href="/detector/clean-account">Account</a></nav></header>`;
const FOOTER = `<footer><small>© 2026 Acme Store · Help · Privacy</small></footer>`;

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title><style>body{font:16px system-ui;max-width:860px;margin:1rem auto}header,footer{display:flex;gap:1rem;padding:.5rem 0}article,section{border:1px solid #ccc;padding:.75rem;margin:.75rem 0}</style></head><body>${NAV}<main>${body}</main>${FOOTER}<script>${script}</script></body></html>`;
}

const PRODUCTS = `<h1>Products</h1><article><h2>Canvas Backpack</h2><p>Price $29.00</p><button>Add to cart</button></article><article><h2>Trail Light</h2><p>Price $9.00</p><button>Add to cart</button></article>`;
const ORDERS_TABLE = `<h1>Your orders</h1><table><thead><tr><th>Order</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody><tr><td>#1042</td><td>12 Oct 2026</td><td>$41.00</td><td>Shipped</td></tr><tr><td>#1039</td><td>2 Oct 2026</td><td>$9.00</td><td>Delivered</td></tr></tbody></table>`;
const ACT = (label: string) => `<button id="act">${label}</button>`;
const SET = (selector: string, text: string) =>
  `document.querySelector('${selector}').textContent=${JSON.stringify(text)}`;

const CASES: readonly DetectorCase[] = [
  {
    id: "console-error",
    expect: { load: ["console_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `console.error("Failed to load recommendations", {code: "RECS_TIMEOUT"})`,
  },
  {
    id: "uncaught-exception",
    expect: { load: ["uncaught_exception"] },
    title: "Products",
    body: PRODUCTS,
    script: `setTimeout(()=>{const cart=undefined;cart.items.push(1)},20)`,
  },
  {
    id: "unhandled-rejection",
    expect: { load: ["unhandled_rejection"] },
    title: "Products",
    body: PRODUCTS,
    script: `fetch('/detector/api/ok').then(r=>r.json()).then(()=>{throw new Error('Unexpected response shape')})`,
  },
  {
    id: "fetch-500",
    expect: { load: ["http_error"] },
    title: "Your orders",
    body: ORDERS_TABLE,
    script: `fetch('/detector/api/fail').catch(()=>{})`,
  },
  {
    id: "xhr-404",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `const x=new XMLHttpRequest();x.open('GET','/detector/api/missing');x.send()`,
  },
  {
    id: "image-404",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS.replace(
      "<h2>Trail Light</h2>",
      `<h2>Trail Light</h2><img alt="" src="/detector/img/trail-light.png" width="40" height="40">`,
    ),
  },
  {
    id: "network-failure",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `fetch('/detector/api/drop').catch(()=>{})`,
  },
  {
    id: "document-500",
    status: 500,
    expect: { load: ["http_error"] },
    title: "Server error",
    body: `<h1>Oops</h1><p>We hit a snag loading this page. Our team has been notified.</p>`,
  },
  {
    id: "click-save-500",
    expect: { load: [], action: ["http_error"] },
    title: "Profile",
    body: `<h1>Profile</h1><label>Display name <input value="Sam"></label>${ACT("Save")}<p id="msg"></p>`,
    script: `document.querySelector('#act').onclick=()=>{fetch('/detector/api/fail',{method:'POST'}).catch(()=>{});${SET("#msg", "Saved")}}`,
  },
  {
    id: "click-exception",
    expect: { load: [], action: ["uncaught_exception"] },
    title: "Cart",
    body: `<h1>Cart</h1><ul><li>Canvas Backpack $29.00</li></ul>${ACT("Apply coupon")}`,
    script: `document.querySelector('#act').onclick=()=>{const coupon=null;coupon.code.trim()}`,
  },
  {
    id: "click-rejection",
    expect: { load: [], action: ["unhandled_rejection"] },
    title: "Checkout",
    body: `<h1>Checkout</h1><p>Total $38.00</p>${ACT("Place order")}<p id="msg"></p>`,
    script: `document.querySelector('#act').onclick=async()=>{${SET("#msg", "Order placed")};await Promise.reject(new Error('payment token expired'))}`,
  },
  {
    id: "clean-warnings",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `console.warn("Deprecated API used");console.log("analytics ready");console.info("v2.3.1")`,
  },
  {
    id: "clean-caught",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `try{null.x}catch(e){};fetch('/detector/api/ok').then(r=>r.json()).catch(()=>{})`,
  },
  {
    id: "clean-late-handler",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `const p=Promise.reject(new Error('retry later'));setTimeout(()=>p.catch(()=>{}),30)`,
  },
  {
    id: "clean-expected-401",
    expect: { load: [] },
    title: "Sign in",
    body: `<h1>Sign in</h1><form><label>Email <input></label><label>Password <input type="password"></label><button type="button">Sign in</button></form>`,
    // Probing a session while signed out is normal; the evaluation allow-lists it.
    script: `fetch('/detector/api/session').catch(()=>{})`,
  },
  {
    id: "clean-redirect",
    expect: { load: [] },
    title: "Your orders",
    body: ORDERS_TABLE,
    script: `fetch('/detector/api/moved').then(r=>r.json()).catch(()=>{})`,
  },
  {
    id: "clean-products",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
  },
  {
    id: "clean-orders",
    expect: { load: [] },
    title: "Your orders",
    body: ORDERS_TABLE,
  },
  {
    id: "clean-account",
    expect: { load: [] },
    title: "Account",
    body: `<h1>Hello, Sam!</h1><p>Member since 2024</p><p>Email: sam@example.com</p><button>Edit profile</button>`,
  },
];

export const DETECTOR_CASES: readonly DetectorCase[] = CASES;

/** Allow rules the evaluation passes, as a project would. */
export const DETECTOR_ALLOW = ["http_error:/detector/api/session"] as const;

export interface DetectorResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
  /** Close the connection without a response, so the request fails at once on every OS. */
  readonly drop?: boolean;
}

const API: Record<string, DetectorResponse> = {
  "/detector/api/ok": {
    status: 200,
    contentType: "application/json",
    body: '{"ok":true}',
  },
  "/detector/api/fail": {
    status: 500,
    contentType: "application/json",
    body: '{"error":"internal"}',
  },
  "/detector/api/session": {
    status: 401,
    contentType: "application/json",
    body: '{"error":"signed out"}',
  },
  "/detector/api/moved": {
    status: 302,
    contentType: "text/plain",
    body: "",
    location: "/detector/api/ok",
  },
  "/detector/api/drop": {
    status: 0,
    contentType: "text/plain",
    body: "",
    drop: true,
  },
};

/** The fixture response for a detector path, or undefined when none. */
export function detectorResponse(
  pathname: string,
): DetectorResponse | undefined {
  if (!pathname.startsWith("/detector/")) return undefined;
  const api = API[pathname];
  if (api) return api;
  const found = CASES.find((item) => pathname === `/detector/${item.id}`);
  if (!found)
    return {
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    };
  return {
    status: found.status ?? 200,
    contentType: "text/html; charset=utf-8",
    body: shell(found.title, found.body, found.script),
  };
}
