import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Phase 7 — the route census.
//
// Every other authorization test in this repository asks "is THIS route
// guarded?". That is necessary but it can only ever cover routes somebody
// remembered to write a test for. This file asks the complementary question:
// "what routes does the application actually mount, and is EVERY one of them
// either authenticated-and-capability-guarded, or on a short list of documented
// exceptions?"
//
// It walks the live Express router tree rather than reading source, so a route
// added tomorrow is covered the moment it is mounted. A new unguarded route
// fails this file with its full method and path printed.
//
// The brief's requirement it discharges: "every new or changed route validates
// input and enforces capability checks" — the authorization half. Per-route
// input validation is proven by the per-route suites, which can assert what
// each field means; a structural walk cannot.

const fs = require("fs");
const path = require("path");

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET: "phase7-route-census-secret-value-at-least-32-chars",
  CORS_ORIGIN: "http://localhost:5173",
};

// Routes that answer without any credential, and why each is allowed to.
// Adding an entry here is a deliberate, reviewable act — which is the whole
// reason the list lives in the test rather than being inferred from the code.
const INTENTIONALLY_PUBLIC = new Map([
  ["GET /", "Liveness/identity banner. Returns a fixed project name and the current time; reads no data and takes no input."],
  ["POST /api/auth/register", "Account creation. Cannot require a credential the caller does not yet have."],
  ["POST /api/auth/login", "Credential exchange. Same reason."],
]);

// Routes that DO authenticate but carry no capability guard, because the only
// subject they expose is the caller themself.
//
// These are not a weaker class of protection by accident. A capability answers
// "may this role reach other people's data?"; that question is not meaningful
// for an endpoint whose entire response is derived from the caller's own
// verified token. Minting a read:own-session capability granted to all four
// roles would add a name, not a boundary.
const AUTHENTICATED_SELF_SCOPED = new Map([
  [
    "GET /api/profile",
    "Session validation. Echoes only req.user (id/email/role, set by authenticate " +
      "from the verified JWT) plus the capability list derived from that role. It " +
      "reads no table and can return no other subject's data, so there is nothing " +
      "for a capability to gate.",
  ],
]);

let app;
let originalEnv;

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);

  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });

  app = require("../../src/app");
});

afterAll(() => {
  process.env = originalEnv;
});

/**
 * Maps each mounted router OBJECT to the prefix app.js mounted it under.
 *
 * Express 5 stopped exposing `layer.path` for a mounted router, and the
 * remaining `matchers` are opaque functions. Guessing the prefix from the route
 * path is what let an earlier draft of this file mistake GET /api/profile for
 * the public GET / banner and excuse it.
 *
 * So the prefix is resolved the only way that cannot drift: read the mount
 * declarations out of app.js, require the same route modules this process has
 * already loaded, and match by object identity. If app.js is edited to mount a
 * router under a different prefix, this map follows it; if a router is mounted
 * that app.js does not declare, it resolves to null and its routes are reported
 * with an explicit "<unmapped>" prefix rather than silently passing.
 */
function buildPrefixByRouter() {
  const appSource = fs.readFileSync(require.resolve("../../src/app"), "utf8");

  // const foo = require("./routes/fooRoutes");
  const moduleByIdentifier = new Map();
  for (const match of appSource.matchAll(
    /const\s+(\w+)\s*=\s*require\(\s*"(\.\/routes\/[^"]+)"\s*\)/g
  )) {
    moduleByIdentifier.set(match[1], match[2]);
  }

  // app.use("/api/x", maybeMiddleware, fooRoutes);
  const prefixByRouter = new Map();
  for (const match of appSource.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g)) {
    const prefix = match[1];
    const args = match[2].split(",").map((part) => part.trim());
    for (const arg of args) {
      const modulePath = moduleByIdentifier.get(arg);
      if (!modulePath) continue;
      // Same resolution the app used, so require() returns the same object.
      const routerObject = require(`../../src/${modulePath.replace(/^\.\//, "")}`);
      prefixByRouter.set(routerObject, prefix);
    }
  }

  return prefixByRouter;
}

/**
 * Walks the Express router tree and returns one record per mounted route.
 *
 * `inherited` carries middleware a parent applied with `.use()`. This codebase
 * attaches `authenticate` both ways — some routers use `router.use(authenticate)`,
 * others repeat it per route — so both must be collected or the census would
 * report correctly-guarded routes as unauthenticated.
 */
function collectRoutes(router, prefixByRouter, prefix = "", inherited = []) {
  const found = [];
  let appLevel = [...inherited];

  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((method) => layer.route.methods[method])
        .map((method) => method.toUpperCase());

      const handlers = [...appLevel, ...layer.route.stack.map((entry) => entry.handle)];
      const routePath = layer.route.path;
      const fullPath =
        prefix === ""
          ? routePath
          : `${prefix}${routePath === "/" ? "" : routePath}`;

      for (const method of methods) {
        found.push({ method, path: fullPath || "/", handlers });
      }
      continue;
    }

    if (layer.name === "router" && layer.handle && Array.isArray(layer.handle.stack)) {
      const mountedPrefix = prefixByRouter.has(layer.handle)
        ? prefixByRouter.get(layer.handle)
        : "<unmapped>";

      const routerLevel = layer.handle.stack
        .filter((entry) => !entry.route)
        .map((entry) => entry.handle);

      found.push(
        ...collectRoutes(layer.handle, prefixByRouter, mountedPrefix, [
          ...appLevel,
          ...routerLevel,
        ])
      );
      continue;
    }

    if (!layer.route && layer.handle) {
      appLevel = [...appLevel, layer.handle];
    }
  }

  return found;
}

function census() {
  return collectRoutes(app.router, buildPrefixByRouter());
}

function classify(route) {
  const authenticated = route.handlers.some((handler) => handler && handler.tnxAuthenticator);
  const guards = route.handlers.filter((handler) => handler && handler.tnxGuard);
  return { authenticated, guards, key: `${route.method} ${route.path}` };
}

describe("Phase 7 — route census", () => {
  it("discovers every mounted route, with its real mount prefix", () => {
    const routes = census();

    // Guards against the walk silently returning nothing, which would make
    // every assertion below pass vacuously.
    expect(routes.length).toBeGreaterThan(40);

    // Every route resolved to a real prefix. "<unmapped>" means app.js mounted a
    // router the source scan could not tie to a module — the census would then
    // be reporting paths it cannot vouch for.
    const unmapped = routes.filter((route) => route.path.startsWith("<unmapped>"));
    expect(unmapped.map((route) => `${route.method} ${route.path}`)).toEqual([]);

    // Spot-check that prefixing actually happened, rather than every route
    // collapsing to its router-relative path.
    const paths = routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("GET /api/profile");
    expect(paths).toContain("POST /api/auth/login");
    expect(paths).toContain("GET /");
  });

  it("guards every mounted route with authentication AND a capability check, except documented exceptions", () => {
    const offenders = [];

    for (const route of census()) {
      const { authenticated, guards, key } = classify(route);

      if (INTENTIONALLY_PUBLIC.has(key)) {
        // A route on the public list must genuinely be reachable without a
        // credential. If somebody later adds authentication to it, the list is
        // stale and should be corrected rather than left lying.
        expect(authenticated, `${key} is on the public list but authenticates`).toBe(false);
        continue;
      }

      if (AUTHENTICATED_SELF_SCOPED.has(key)) {
        // The exception is "no capability", never "no authentication".
        expect(authenticated, `${key} is self-scoped but does not authenticate`).toBe(true);
        continue;
      }

      if (!authenticated || guards.length === 0) {
        offenders.push({ route: key, authenticated, capabilityGuards: guards.length });
      }
    }

    expect(
      offenders,
      "Every route must authenticate and enforce a capability, or be listed in " +
        "INTENTIONALLY_PUBLIC / AUTHENTICATED_SELF_SCOPED with a reason.\n" +
        JSON.stringify(offenders, null, 2)
    ).toEqual([]);
  });

  it("names a real capability in every capability guard", () => {
    // Catches a guard built with a typo'd or since-deleted capability string.
    const { CAPABILITY_VALUES } = require("../../src/lib/roles");
    const bad = [];

    for (const route of census()) {
      for (const handler of route.handlers) {
        if (!handler || !handler.tnxGuard) continue;
        const { kind, capabilities } = handler.tnxGuard;
        if (kind !== "capability") continue;
        for (const capability of capabilities || []) {
          if (!CAPABILITY_VALUES.includes(capability)) {
            bad.push({ route: `${route.method} ${route.path}`, capability });
          }
        }
      }
    }

    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
  });

  it("keeps the unauthenticated surface to exactly three routes", () => {
    // A regression fence. Widening the public surface should require editing
    // this list and explaining why in review, not quietly adding a map entry.
    expect([...INTENTIONALLY_PUBLIC.keys()].sort()).toEqual([
      "GET /",
      "POST /api/auth/login",
      "POST /api/auth/register",
    ]);

    // And the exception lists must not be padded with routes that no longer
    // exist, which would hide the fact that a real route lost its guard.
    const keys = new Set(census().map((route) => `${route.method} ${route.path}`));
    for (const listed of [...INTENTIONALLY_PUBLIC.keys(), ...AUTHENTICATED_SELF_SCOPED.keys()]) {
      expect(keys.has(listed), `${listed} is excused but is not mounted`).toBe(true);
    }
  });

  it("keeps the capability-free authenticated surface to exactly one self-scoped route", () => {
    expect([...AUTHENTICATED_SELF_SCOPED.keys()]).toEqual(["GET /api/profile"]);
  });

  it("does not trust a client-supplied proxy header", () => {
    // `trust proxy` unset is what makes req.ip the real socket address, which is
    // what makes the rate limiter's key unforgeable. Enabling it without a
    // trusted proxy in front would silently defeat that control.
    expect(app.get("trust proxy")).toBeFalsy();
  });
});
