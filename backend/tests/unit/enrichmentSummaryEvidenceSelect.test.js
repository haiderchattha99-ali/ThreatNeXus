import { describe, it, expect } from "vitest";

// UX Ticket C — the summary read's evidence `select` IS the serializer.
//
// A column that is not named in it can never reach a client, and a column that
// IS named reaches every caller of this endpoint. So the allow-list is the
// security boundary and the feature at once, and it is asserted directly rather
// than inferred from a rendered row.
//
// What these tests defend:
//   - every normalized, analyst-facing column each provider already stores is
//     returned, so the evidence viewer shows what ThreatNeXus actually retained
//     instead of the subset the old preview happened to need
//   - the transport/diagnostic columns (httpStatus, errorCode, errorMessage,
//     retryAfterSeconds) and internal keys stay unnamed, on every provider

const repository = require("../../src/services/enrichmentOrchestration/enrichmentOrchestrationRepository");

const NEVER_SELECTED = [
  "httpStatus",
  "errorCode",
  "errorMessage",
  "retryAfterSeconds",
  "cacheKey",
  "claimToken",
  "activeCacheKey",
  "id",
];

/** Captures the Prisma args the summary read issues for one subject. */
async function captureArgs() {
  let captured = null;
  const client = {
    findingEnrichmentRunItem: {
      findFirst: async (args) => {
        captured = args;
        return null;
      },
    },
  };
  await repository.findLatestRunItemForSubject(client, {
    findingId: 1,
    provider: "netlas",
    subjectType: "IPV4",
    subjectValue: "198.18.0.9",
  });
  return captured;
}

const selectedKeys = (args, relation) =>
  Object.keys(args.include.lookupJob.include[relation].select);

describe("the summary read returns every stored analyst-facing provider column", () => {
  it("returns all fifteen normalized Netlas columns, including the six the preview never used", async () => {
    const keys = selectedKeys(await captureArgs(), "netlasEnrichment");

    expect(keys).toEqual(
      expect.arrayContaining([
        "queriedAt",
        "services",
        "products",
        "hostnames",
        "dnsNames",
        "organization",
        "asn",
        "asnOrg",
        "country",
        "certificateSubject",
        "certificateIssuer",
        "certificateSan",
        "firstSeen",
        "lastSeen",
        "link",
      ])
    );
    expect(keys).not.toEqual(expect.arrayContaining(NEVER_SELECTED));
  });

  it("returns the GreyNoise link and message the summary previously omitted", async () => {
    const keys = selectedKeys(await captureArgs(), "greyNoiseEnrichment");

    expect(keys).toEqual(
      expect.arrayContaining(["noise", "riot", "classification", "actorName", "lastSeen", "link", "message"])
    );
    expect(keys).not.toEqual(expect.arrayContaining(NEVER_SELECTED));
  });

  it("returns the Shodan link and country code alongside its existing columns", async () => {
    const keys = selectedKeys(await captureArgs(), "shodanEnrichment");

    expect(keys).toEqual(
      expect.arrayContaining([
        "services",
        "hostnames",
        "organization",
        "isp",
        "country",
        "countryCode",
        "city",
        "vulnerabilities",
        "lastUpdate",
        "link",
      ])
    );
    expect(keys).not.toEqual(expect.arrayContaining(NEVER_SELECTED));
  });

  it("keeps the Censys certificate COUNT and never its contents", async () => {
    const keys = selectedKeys(await captureArgs(), "censysEnrichment");

    expect(keys).toEqual(
      expect.arrayContaining([
        "services",
        "autonomousSystemNumber",
        "autonomousSystemName",
        "certificateCount",
      ])
    );
    expect(keys).not.toEqual(expect.arrayContaining(NEVER_SELECTED));
  });

  it("returns the vulnerability batch's normalized NVD, CISA KEV and FIRST EPSS columns", async () => {
    const args = await captureArgs();
    const keys = Object.keys(
      args.include.lookupJob.include.vulnerabilityEnrichmentJob.include.providerResults.select
    );

    // Attribution first: without provider and status, three sources would be
    // indistinguishable and a failed one would read as an empty answer.
    expect(keys).toEqual(expect.arrayContaining(["provider", "status", "queriedAt", "expiresAt"]));
    // NVD
    expect(keys).toEqual(
      expect.arrayContaining([
        "nvdCveStatus",
        "englishDescription",
        "cvssVersion",
        "cvssBaseScoreTenths",
        "cvssSeverity",
        "primaryCweIds",
        "publishedAt",
        "lastModifiedAt",
        "sourceIdentifier",
      ])
    );
    // CISA KEV
    expect(keys).toEqual(
      expect.arrayContaining([
        "isKnownExploited",
        "dateAdded",
        "dueDate",
        "knownRansomwareCampaignUse",
        "requiredAction",
        "catalogVersion",
        "catalogReleasedAt",
      ])
    );
    // FIRST EPSS
    expect(keys).toEqual(
      expect.arrayContaining([
        "epssProbabilityBasisPoints",
        "epssPercentileBasisPoints",
        "modelDate",
      ])
    );
    expect(keys).not.toEqual(expect.arrayContaining([...NEVER_SELECTED, "jobId", "createdAt"]));
  });
});

describe("the summary read stays a read", () => {
  it("issues a findFirst and nothing else — no create, update or upsert", async () => {
    const calls = [];
    const client = new Proxy(
      {},
      {
        get: (_target, model) =>
          new Proxy(
            {},
            {
              get: (_t, method) => {
                calls.push(`${String(model)}.${String(method)}`);
                return async () => null;
              },
            }
          ),
      }
    );

    await repository.findLatestRunItemForSubject(client, {
      findingId: 1,
      provider: "netlas",
      subjectType: "IPV4",
      subjectValue: "198.18.0.9",
    });

    expect(calls).toEqual(["findingEnrichmentRunItem.findFirst"]);
  });
});
