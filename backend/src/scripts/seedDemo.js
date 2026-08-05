"use strict";

// ===========================================================================
// Deterministic demonstration dataset.
//
// WHY IT DRIVES HTTP RATHER THAN SERVICES
// ---------------------------------------
// Every fixture below is created by calling the application's own REST API,
// in-process, with a real JWT for the role that is actually entitled to perform
// that step. Nothing here writes to Prisma directly except the two
// configuration entities that are not workflow evidence (Organizations and
// their AssetMappings, both created through their own admin endpoints anyway).
//
// That is a deliberate design choice, not a convenience:
//   - it cannot bypass a capability check, because it goes through the same
//     middleware chain an analyst's browser does;
//   - it cannot bypass a workflow rule, because the services run unchanged;
//   - the separation of duties is demonstrated rather than asserted — the
//     ANALYST token is used to request a closure and it is REFUSED an approval,
//     which only the REVIEWER token can perform.
// A seed that reached past the routes could quietly create states the product
// cannot actually reach, and the demo would then prove nothing.
//
// SAFETY
// ------
//   - refuses to run when NODE_ENV=production
//   - refuses to run unless DEMO_MODE=true is set explicitly
//   - refuses to run without DEMO_USER_PASSWORD (never defaulted, never printed)
//   - idempotent: re-running detects what already exists and skips it, so it
//     never doubles a case or re-uploads a report (file-level idempotency in
//     the ingestion path makes the second upload a recognised duplicate)
//   - never truncates, resets or drops anything
//   - no network: the IOC provider stays "mock" and AI stays disabled
//
// WHAT IT DOES NOT DO
// -------------------
// It does not fabricate a risk score, a band, an occurrence count or a
// timestamp. Findings, their lifecycle, their ownership and their Risk v1
// scores are all produced by the real engines from the synthetic CSVs in
// data/synthetic/accessible-rdp/. If a band looks a certain way in the demo, it
// is because the locked scoring contract produced it.
//
// Usage:
//   DEMO_MODE=true DEMO_USER_PASSWORD='<local-only-password>' npm run seed:demo
// ===========================================================================

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// Where the fixture directory lives.
//
// The relative walk above is correct on a developer's machine, where this file
// sits at <repo>/backend/src/scripts/ and three levels up is the repository
// root. It is WRONG inside the Docker image, where the Dockerfile copies src to
// /app/src — there is no backend/ level, so three levels up from
// /app/src/scripts is "/" and the fixtures resolve to /data instead of
// /app/data. The Phase 7 clean-stack proof hit this: the demo seed found no
// fixtures and produced an entirely empty demonstration.
//
// TNX_DATA_DIR makes the location explicit rather than inferred from directory
// depth, and docker-compose.yml sets it to the mount point. Nothing guesses.
const DATA_ROOT = process.env.TNX_DATA_DIR
  ? path.resolve(process.env.TNX_DATA_DIR)
  : path.join(REPO_ROOT, "data");

// Demo-specific fixtures. Kept separate from data/synthetic/accessible-rdp/,
// which belongs to the Phase 1 evaluator and whose ground truth must not be
// perturbed by demonstration edits. These cover the ownership outcomes the
// evaluator fixtures do not: a second organization, an unresolved indicator,
// and an ASN-attributed (ISP, low-confidence) indicator.
const CSV_DIR = path.join(DATA_ROOT, "demo", "accessible-rdp");

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertSafeToRun() {
  const nodeEnv = (process.env.NODE_ENV || "development").trim();
  if (nodeEnv === "production") {
    throw new Error(
      "seed:demo refuses to run with NODE_ENV=production. The demonstration " +
        "dataset is for local development and demonstration only."
    );
  }
  if ((process.env.DEMO_MODE || "").trim().toLowerCase() !== "true") {
    throw new Error(
      "seed:demo requires DEMO_MODE=true to be set explicitly. This is a " +
        "deliberate opt-in so demonstration data can never be created by accident."
    );
  }
  const password = process.env.DEMO_USER_PASSWORD;
  if (typeof password !== "string" || password.trim().length < 12) {
    throw new Error(
      "seed:demo requires DEMO_USER_PASSWORD (at least 12 characters), supplied " +
        "as a one-off shell variable. It is never defaulted and never printed."
    );
  }
  return password;
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------
//
// Organizations are obviously fictional. Names, contacts and domains are
// invented; the address ranges are RFC 5737 documentation blocks, which exist
// precisely so examples cannot collide with real hosts. No real constituent,
// no real contact and no real victim appears anywhere.

const DEMO_MARKER = "demo.threatnexus.invalid";

const ORGANIZATIONS = [
  {
    name: "Meridian Health Trust",
    industry: "Healthcare",
    location: "Demonstration dataset — no real location",
    contactPerson: "Demo Contact",
    email: `meridian-health@${DEMO_MARKER}`,
    sector: "HEALTHCARE",
    // Exact-prefix ownership: the strongest non-override resolution tier.
    mappings: [{ type: "CIDR", value: "203.0.113.0/25", confidence: "HIGH" }],
  },
  {
    name: "Northport Water Authority",
    industry: "Water utility",
    location: "Demonstration dataset — no real location",
    contactPerson: "Demo Contact",
    email: `northport-water@${DEMO_MARKER}`,
    sector: "ENERGY",
    mappings: [{ type: "CIDR", value: "198.51.100.0/26", confidence: "HIGH" }],
  },
  {
    name: "Cedarline Telecom",
    industry: "Telecommunications",
    location: "Demonstration dataset — no real location",
    contactPerson: "Demo Contact",
    email: `cedarline-telecom@${DEMO_MARKER}`,
    sector: "TELECOMMUNICATIONS",
    // ASN attribution only — deliberately LOW confidence, so the demo shows an
    // ISP-attributed finding that an analyst must treat with care rather than
    // notify directly.
    mappings: [{ type: "ASN", value: "64500", confidence: "LOW" }],
  },
];

// Uploaded in order. These are the same fixtures the Phase 1 evaluator uses, so
// the persistence and recurrence chains they produce are the ones already
// proven correct by `npm run eval:phase1`.
const REPORTS = ["demo_01_baseline.csv", "demo_02_persistence.csv", "demo_03_latest.csv"];

// ---------------------------------------------------------------------------
// In-process HTTP driver
// ---------------------------------------------------------------------------

function createClient(baseUrl) {
  const tokens = {};

  async function call(method, route, { role, body, raw, query } = {}) {
    const url = new URL(baseUrl + route);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = {};
    if (role) headers.Authorization = `Bearer ${tokens[role]}`;

    let payload;
    if (raw) {
      payload = raw;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(url, { method, headers, body: payload });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  }

  return {
    tokens,
    call,
    get: (route, options) => call("GET", route, options),
    post: (route, options) => call("POST", route, options),
    put: (route, options) => call("PUT", route, options),
  };
}

function ok(result, what) {
  if (result.status >= 200 && result.status < 300) return result.body;
  const message = result.body && result.body.message ? result.body.message : "";
  throw new Error(`${what} failed with HTTP ${result.status}${message ? `: ${message}` : ""}`);
}

const log = (...args) => console.log("[seed:demo]", ...args);

// Performs one workflow step and REPORTS the outcome instead of aborting the
// run. A step that a previous run already completed answers 409, which is the
// correct answer and not a failure of this script — replaying the seed must
// converge on the same state rather than blow up half way through.
async function step(client, method, route, role, body, label) {
  const result = await client.call(method, route, { role, body });
  if (result.status >= 200 && result.status < 300) {
    log(`${label}: ok`);
    return result.body;
  }
  log(
    `${label}: skipped (HTTP ${result.status}` +
      `${result.body?.code ? ` [${result.body.code}]` : ""})`
  );
  return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function signIn(client, password) {
  const accounts = {
    ADMIN: "admin@threatnexus.local",
    ANALYST: "analyst@threatnexus.local",
    REVIEWER: "reviewer@threatnexus.local",
    VIEWER: "viewer@threatnexus.local",
  };

  for (const [role, email] of Object.entries(accounts)) {
    const result = await client.post("/api/auth/login", { body: { email, password } });
    if (result.status !== 200 || !result.body?.token) {
      throw new Error(
        `Could not sign in as ${role}. Run \`npm run seed:users\` first with the ` +
          "same password, then re-run this script."
      );
    }
    client.tokens[role] = result.body.token;
  }
  log("signed in as ADMIN, ANALYST, REVIEWER and VIEWER");
}

async function ensureOrganizations(client) {
  const existing = ok(await client.get("/api/organizations", { role: "ADMIN" }), "list organizations");
  const byName = new Map((existing.data || []).map((o) => [o.name, o]));
  const created = {};

  for (const org of ORGANIZATIONS) {
    let record = byName.get(org.name);
    if (record) {
      log(`organization already present: ${org.name}`);
    } else {
      const result = ok(
        await client.post("/api/organizations", {
          role: "ADMIN",
          body: {
            name: org.name,
            industry: org.industry,
            location: org.location,
            contactPerson: org.contactPerson,
            email: org.email,
            sector: org.sector,
          },
        }),
        `create organization ${org.name}`
      );
      record = result.data;
      log(`organization created: ${org.name}`);
    }
    created[org.name] = record;

    // Ownership mappings. These are what let the real resolver attribute a
    // Finding — the demo never sets an owner on a Finding directly.
    //
    // The identifier field is named for its type (cidr / asn / exactIp) and the
    // service REFUSES a payload that carries the wrong one, so the body is
    // built per type rather than with a generic `value`.
    for (const mapping of org.mappings) {
      const identifier =
        mapping.type === "CIDR"
          ? { cidr: mapping.value }
          : mapping.type === "ASN"
            ? { asn: Number(mapping.value) }
            : { exactIp: mapping.value };

      const result = await client.post("/api/ownership/mappings", {
        role: "ADMIN",
        body: {
          organizationId: record.id,
          mappingType: mapping.type,
          ...identifier,
          confidence: mapping.confidence,
          source: "MANUAL",
          provenanceNote: "Demonstration dataset mapping (synthetic).",
        },
      });
      if (result.status === 201 || result.status === 200) {
        log(`  mapping ${mapping.type} ${mapping.value} -> ${org.name}`);
      } else if (result.status === 409) {
        log(`  mapping ${mapping.type} ${mapping.value} already present`);
      } else {
        throw new Error(
          `create mapping ${mapping.value} failed with HTTP ${result.status}` +
            (result.body?.message ? `: ${result.body.message}` : "")
        );
      }
    }
  }
  return created;
}

async function ingestReports(client) {
  // A demonstration seed that finds none of its fixtures used to log three
  // skips, report "findings total=0", and exit 0 — which is how the Phase 7
  // clean-stack proof ended up with a completely empty demo while every command
  // reported success. Missing fixtures are a hard failure now: the entire point
  // of this script is to produce a deterministic dataset, and producing nothing
  // is not a quieter version of that, it is the opposite of it.
  const missing = REPORTS.filter((filename) => !fs.existsSync(path.join(CSV_DIR, filename)));
  if (missing.length === REPORTS.length) {
    throw new Error(
      `No demonstration fixtures found in ${CSV_DIR}. Expected: ${REPORTS.join(", ")}. ` +
        "If you are running inside the Docker stack, the repository's data/ directory is " +
        "mounted read-only at /app/data by docker-compose.yml — check that the compose file " +
        "you started from declares that mount."
    );
  }

  const summaries = [];
  for (const filename of REPORTS) {
    const filePath = path.join(CSV_DIR, filename);
    if (!fs.existsSync(filePath)) {
      // The path named here is CSV_DIR itself. It previously said
      // "data/synthetic/accessible-rdp/" while CSV_DIR is data/demo/, which
      // sent anyone debugging this straight to the wrong directory.
      log(`skipping ${filename} — not present in ${CSV_DIR}`);
      continue;
    }

    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(filePath)], { type: "text/csv" }), filename);

    // ANALYST holds ingest:reports. Uploading as ADMIN would work too, but the
    // demo should show the role that actually does this work doing it.
    const result = await client.post("/api/reports/upload", { role: "ANALYST", raw: form });

    if (result.status === 200 || result.status === 201) {
      const data = result.body?.data || {};
      log(
        `ingested ${filename}: status=${data.status ?? "?"} ` +
          `validRows=${data.validRows ?? "?"} invalidRows=${data.invalidRows ?? "?"}`
      );
      summaries.push({ filename, data });
    } else if (result.status === 409) {
      // File-level idempotency: identical bytes are recognised as the same
      // evidence rather than creating a second report.
      log(`already ingested (identical bytes): ${filename}`);
    } else {
      throw new Error(
        `upload ${filename} failed with HTTP ${result.status}` +
          (result.body?.message ? `: ${result.body.message}` : "")
      );
    }
  }
  return summaries;
}

async function pickFindings(client) {
  const listing = ok(
    await client.get("/api/findings", { role: "ANALYST", query: { pageSize: 100, sort: "lastSeen" } }),
    "list findings"
  );
  return listing.data.items;
}

async function ensureCases(client, findings) {
  // Idempotency is per ORGANIZATION, not all-or-nothing. An earlier run may
  // have covered only the organizations that existed then; re-running must be
  // able to fill in the rest rather than deciding "some demo case exists, so
  // there is nothing left to do".
  const existing = ok(await client.get("/api/cases", { role: "ANALYST" }), "list cases");
  const existingDemoCases = (existing.data || []).filter((c) =>
    (c.title || "").startsWith("[DEMO]")
  );
  const alreadyCovered = new Set(
    existingDemoCases.map((c) => c.organizationId).filter((id) => Number.isInteger(id))
  );

  // Group the findings by the organization the real resolver attributed them
  // to. The demo does not choose owners; it reads what resolution produced.
  const byOrg = new Map();
  for (const finding of findings) {
    const org = finding.ownership?.organization;
    if (!org) continue;
    if (!byOrg.has(org.id)) byOrg.set(org.id, { org, findings: [] });
    byOrg.get(org.id).findings.push(finding);
  }

  const created = [];
  let index = 0;

  for (const { org, findings: orgFindings } of byOrg.values()) {
    if (alreadyCovered.has(org.id)) {
      log(`demo case already present for ${org.name} — skipping`);
      continue;
    }
    index += 1;
    // Triage first: escalating a Finding is what justifies opening a case.
    const evidence = orgFindings.slice(0, 3);
    for (const finding of evidence) {
      ok(
        await client.put(`/api/findings/${finding.id}/triage`, {
          role: "ANALYST",
          body: {
            decision: "ESCALATED",
            reason: "Demonstration dataset: exposure confirmed against a synthetic report.",
          },
        }),
        `triage finding ${finding.id}`
      );
    }

    const createdCase = ok(
      await client.post("/api/cases", {
        role: "ANALYST",
        body: {
          title: `[DEMO] Accessible RDP exposure — ${org.name}`,
          threatType: "Accessible RDP exposure",
          organization: org.name,
          organizationId: org.id,
          priority: index === 1 ? "High" : "Medium",
          analyst: "analyst@threatnexus.local",
          description:
            "Demonstration case built from synthetic Shadowserver-style accessible-RDP fixtures.",
        },
      }),
      `create case for ${org.name}`
    );

    const caseId = createdCase.data.id;
    log(`case created: ${createdCase.data.caseReference || caseId} (${org.name})`);

    // A link the workflow refuses is REPORTED, not forced. The seed records
    // what the product actually permits; if a rule declines a piece of
    // evidence, the demo shows that rule holding rather than reaching past it.
    const linked = [];
    for (const finding of evidence) {
      const result = await client.post(`/api/cases/${caseId}/findings`, {
        role: "ANALYST",
        body: { findingId: finding.id, reason: "Primary evidence for this exposure." },
      });
      if (result.status >= 200 && result.status < 300) {
        linked.push(finding);
      } else {
        log(
          `  link of finding ${finding.id} (${finding.indicatorValue}) refused: ` +
            `HTTP ${result.status}${result.body?.code ? ` [${result.body.code}]` : ""}` +
            `${result.body?.message ? ` — ${result.body.message}` : ""}`
        );
      }
    }
    log(`  ${linked.length}/${evidence.length} findings linked as evidence`);

    created.push({ caseId, org, evidence: linked, createdCase: createdCase.data });
  }

  // Existing demo cases are returned alongside newly created ones so an
  // interrupted earlier run can be finished rather than left half-driven. Each
  // workflow step below re-checks the case's real state, so replaying is safe.
  const carried = existingDemoCases
    .filter((c) => !created.some((entry) => entry.caseId === c.id))
    .map((c) => ({
      caseId: c.id,
      org: { id: c.organizationId, name: c.ownerOrganization?.name || c.organization },
      evidence: [],
      createdCase: c,
      preexisting: true,
    }));

  return { skipped: false, cases: [...created, ...carried] };
}

async function driveWorkflow(client, cases) {
  if (!cases.length) {
    log("no organization-bound cases to drive — ownership resolved nothing");
    return
  }

  // --- Case 1: waiting for the organization, then a response ---------------
  const first = cases[0];
  await step(client, "POST", `/api/cases/${first.caseId}/state`, "ANALYST",
    { toState: "WAITING_FOR_ORG", note: "Notification prepared for the constituent." },
    "case 1 -> WAITING_FOR_ORG");
  await step(client, "POST", `/api/cases/${first.caseId}/responses`, "ANALYST",
    {
      responseType: "ACKNOWLEDGED",
      summary: "Constituent acknowledged the report and is investigating.",
      occurredAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
    },
    "case 1 organization response");

  // --- Case 2: closure requested, then approved by the REVIEWER ------------
  // Only attempted on a case that actually has linked evidence: a closure with
  // nothing to close is refused by the workflow, correctly.
  // Evidence is read back from the SERVER, not from this script's local list: a
  // case created by an earlier run carries links this process never saw.
  let closable = null;
  for (const candidate of cases) {
    if (candidate === first) continue;
    const view = await client.get(`/api/cases/${candidate.caseId}/workflow`, { role: "ANALYST" });
    const linked = view.body?.data?.linkedFindings || [];
    if (linked.some((l) => l.state === "LINKED" || l.linkState === "LINKED" || l.findingId)) {
      closable = candidate;
      break;
    }
  }
  if (closable) {
    // Closing as REMEDIATED requires the organization to have actually said so:
    // the workflow answers REMEDIATED_RESPONSE_REQUIRED otherwise. The demo
    // records the response first rather than closing on an analyst's say-so.
    await step(client, "POST", `/api/cases/${closable.caseId}/responses`, "ANALYST",
      {
        responseType: "REMEDIATED",
        summary: "Constituent reported the exposed service has been withdrawn from the Internet.",
        occurredAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      },
      "case 2 REMEDIATED organization response");

    const requested = await step(
      client, "POST", `/api/cases/${closable.caseId}/closure-requests`, "ANALYST",
      {
        closureReason: "REMEDIATED",
        justification:
          "Constituent confirmed the service is no longer reachable from the public Internet.",
      },
      "case 2 closure request"
    );

    const requestId =
      requested?.data?.closureRequests?.find((r) => r.state === "PENDING")?.id ??
      requested?.data?.closureRequest?.id ?? null;

    if (requestId) {
      // The separation of duties, demonstrated rather than described: the
      // ANALYST who asked is refused, and only the REVIEWER can grant it.
      const selfApproval = await client.post(
        `/api/cases/${closable.caseId}/closure-requests/${requestId}/approve`,
        { role: "ANALYST", body: { reviewNote: "Attempting to approve my own request." } }
      );
      if (selfApproval.status !== 403) {
        throw new Error(
          `Expected the analyst's self-approval to be refused with 403, got ${selfApproval.status}. ` +
            "The demo will not record a state the product should not allow."
        );
      }
      log("case 2: analyst self-approval correctly refused (403)");

      await step(
        client, "POST", `/api/cases/${closable.caseId}/closure-requests/${requestId}/approve`,
        "REVIEWER", { reviewNote: "Evidence of remediation reviewed and accepted." },
        "case 2 closure approval (reviewer)"
      );
    }
  } else {
    log("no case carries linked evidence yet — closure chain not attempted");
  }

  // --- Framework mappings on case 1 ---------------------------------------
  // NIST CSF on a control-gap basis. Deliberately NOT ATT&CK: these fixtures
  // are exposure observations with no adversary behaviour, and the server
  // refuses an ATT&CK mapping that rests on exposure alone. The demo shows the
  // rule holding rather than working around it.
  await step(client, "POST", `/api/cases/${first.caseId}/framework-mappings`, "ANALYST",
    {
      framework: "NIST_CSF",
      frameworkVersion: "2.0",
      referenceId: "PR.AA-05",
      referenceTitle: "Access permissions, entitlements and authorizations are managed",
      mappingScope: "CASE",
      evidenceBasis: "CONTROL_GAP",
      rationale:
        "A management service is reachable from the public Internet on the affected host, " +
        "which indicates access to it is not being restricted as intended.",
      evidenceQuote: "Constituent acknowledged the report and is investigating.",
      evidenceQuoteSource: "CASE_RESPONSE",
      evidenceConfidence: "HIGH",
      mappingConfidence: "MEDIUM",
    },
    "case 1 NIST CSF PR.AA-05 mapping");

  // Prove the ATT&CK evidence rule is live in the demo dataset, without
  // recording anything: the attempt is EXPECTED to be refused.
  const attack = await client.post(`/api/cases/${first.caseId}/framework-mappings`, {
    role: "ANALYST",
    body: {
      framework: "MITRE_ATTACK",
      frameworkVersion: "v19.1",
      referenceId: "T1133",
      referenceTitle: "External Remote Services",
      mappingScope: "CASE",
      evidenceBasis: "OBSERVED_BEHAVIOR",
      rationale: "The host exposes RDP to the Internet and has a high risk score.",
      evidenceQuote: "Constituent acknowledged the report and is investigating.",
      evidenceQuoteSource: "CASE_RESPONSE",
      evidenceConfidence: "HIGH",
      mappingConfidence: "LOW",
    },
  });
  log(
    attack.status >= 400
      ? `case 1: exposure-only ATT&CK mapping correctly refused (HTTP ${attack.status})`
      : `WARNING: exposure-only ATT&CK mapping was accepted (HTTP ${attack.status})`
  );

  // Record the honest completed assessment. An empty ATT&CK column could mean
  // nobody looked; this says an analyst did look and found exposure evidence,
  // not adversary behaviour. The navigator renders this separately from both
  // mappings and unfinished work.
  await step(
    client,
    "POST",
    `/api/cases/${first.caseId}/framework-mappings/no-applicable`,
    "ANALYST",
    {
      framework: "MITRE_ATTACK",
      rationale:
        "The loaded evidence establishes public RDP exposure and a constituent acknowledgement, " +
        "but records no observed adversary behaviour. Assigning an ATT&CK technique would overstate it.",
    },
    "case 1 explicit no-applicable ATT&CK determination"
  );

  // --- Notification workflow on case 1 -------------------------------------
  let notificationId = null;
  const existingNotifications = await client.get("/api/notifications", {
    role: "ANALYST",
    query: { caseId: first.caseId, limit: 5 },
  });
  const already = existingNotifications.body?.data?.notifications?.[0];
  if (already) {
    notificationId = already.id;
    log(`notification already drafted for case 1: ${already.notificationReference || notificationId}`);
  } else {
    const draft = await client.post("/api/notifications", {
      role: "ANALYST",
      body: { caseId: first.caseId },
    });
    if (draft.status >= 200 && draft.status < 300) {
      // The detail serializer nests the record: { data: { notification, ... } }.
      const drafted = draft.body.data.notification || draft.body.data;
      notificationId = drafted.id;
      log(`notification drafted: ${drafted.notificationReference || notificationId}`);
    } else {
      log(`notification draft skipped (HTTP ${draft.status})`);
    }
  }

  if (!notificationId) return;

  await step(client, "POST", `/api/notifications/${notificationId}/submit`, "ANALYST", {},
    "notification submitted for review");

  // Again the separation of duties: the author cannot approve their own draft.
  const selfApprove = await client.post(`/api/notifications/${notificationId}/approve`, {
    role: "ANALYST",
    body: { reviewNote: "Attempting to approve my own draft." },
  });
  log(
    selfApprove.status === 403
      ? "notification: analyst self-approval correctly refused (403)"
      : `WARNING: analyst self-approval returned ${selfApprove.status}, expected 403`
  );

  await step(client, "POST", `/api/notifications/${notificationId}/approve`, "REVIEWER",
    { reviewNote: "Content and recipient binding verified." },
    "notification approved by reviewer (exact current revision)");

  // Export produces a FILE. It is not a send, and it creates no delivery row.
  const exported = await client.get(`/api/notifications/${notificationId}/export`, {
    role: "ANALYST",
    query: { format: "EML" },
  });
  log(
    exported.status === 200
      ? "notification: .eml artifact exported (export is not delivery)"
      : `notification export skipped (HTTP ${exported.status})`
  );

  // Delivery is a separate, explicit human observation, recorded afterwards.
  await step(client, "POST", `/api/notifications/${notificationId}/deliveries`, "ANALYST",
    {
      status: "SENT_MANUALLY",
      occurredAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      note: "Sent by hand from the analyst mailbox during the demonstration.",
    },
    "notification manual delivery observation");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const password = assertSafeToRun();

  // Force the safe provider posture for the whole run, before the app config is
  // built. The demo must never make a live provider call or enable AI.
  process.env.IOC_ENRICHMENT_PROVIDER = "mock";
  process.env.AI_ENABLED = "false";

  // eslint-disable-next-line global-require
  const app = require("../app");

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address();
  const client = createClient(`http://127.0.0.1:${port}`);

  try {
    log("demonstration dataset — synthetic data only, no real constituent information");
    await signIn(client, password);
    await ensureOrganizations(client);
    await ingestReports(client);

    const findings = await pickFindings(client);
    log(`${findings.length} findings visible after ingestion`);

    const { skipped, cases } = await ensureCases(client, findings);
    if (!skipped) await driveWorkflow(client, cases);

    const overview = ok(
      await client.get("/api/dashboard/overview", { role: "ADMIN" }),
      "read overview"
    );
    const f = overview.data.sections.findings.metrics;
    log(
      `done. findings total=${f.total.value} open=${f.open.value} ` +
        `persistent=${f.persistent.value} recurred=${f.withRecurrence.value}`
    );
    log("every figure above was counted from the database, not written by this script.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      // Never prints the password or any provider key — only the message.
      console.error("[seed:demo] failed:", error.message);
      process.exit(1);
    });
}

module.exports = { assertSafeToRun, ORGANIZATIONS, REPORTS };
