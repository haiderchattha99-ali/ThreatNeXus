import { describe, it, expect } from "vitest";

const {
  AssetMappingValidationError,
  AssetMappingNotFoundError,
  MAX_PROVENANCE_NOTE_LENGTH,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  createAssetMapping,
  updateAssetMapping,
  disableAssetMapping,
  listAssetMappings,
  resolvePagination,
  serializeAssetMapping,
  assetMappingAuditSummary,
} = require("../../src/services/ownership/assetMappingService");

// In-memory fake covering only what assetMappingService touches:
// prisma.assetMapping.{create,update,findUnique,findMany,count}.
function createFakeClient() {
  let nextId = 1;
  const rows = new Map();

  return {
    assetMapping: {
      async create({ data }) {
        const id = nextId++;
        const row = {
          id,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(id, row);
        return { ...row };
      },
      async findUnique({ where: { id } }) {
        const row = rows.get(id);
        return row ? { ...row } : null;
      },
      async update({ where: { id }, data }) {
        const row = rows.get(id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      async findMany({ where, skip = 0, take }) {
        let list = [...rows.values()].filter((r) => matches(r, where));
        list = list.sort((a, b) => a.id - b.id);
        return list.slice(skip, skip + take).map((r) => ({ ...r }));
      },
      async count({ where }) {
        return [...rows.values()].filter((r) => matches(r, where)).length;
      },
    },
    _rows: rows,
  };

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }
}

function validExactIpBody(overrides = {}) {
  return {
    organizationId: 1,
    mappingType: "EXACT_IP",
    exactIp: "203.0.113.10",
    confidence: "HIGH",
    source: "MANUAL",
    ...overrides,
  };
}

function validCidrBody(overrides = {}) {
  return {
    organizationId: 1,
    mappingType: "CIDR",
    cidr: "203.0.113.0/24",
    confidence: "MEDIUM",
    source: "MANUAL",
    ...overrides,
  };
}

function validAsnBody(overrides = {}) {
  return {
    organizationId: 1,
    mappingType: "ASN",
    asn: 64500,
    confidence: "LOW",
    source: "MANUAL",
    ...overrides,
  };
}

describe("createAssetMapping — EXACT_IP", () => {
  it("creates a mapping with derived ipStart/ipEnd and null cidr/asn", async () => {
    const client = createFakeClient();
    const mapping = await createAssetMapping(validExactIpBody(), { client, actorUserId: 7 });
    expect(mapping.exactIp).toBe("203.0.113.10");
    expect(mapping.ipStart).toBe(mapping.ipEnd);
    expect(mapping.cidr).toBeNull();
    expect(mapping.asn).toBeNull();
    expect(mapping.createdByUserId).toBe(7);
    expect(mapping.updatedByUserId).toBe(7);
  });

  it("rejects a malformed IPv4 address", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(validExactIpBody({ exactIp: "999.0.0.1" }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("rejects when cidr or asn is also supplied", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(validExactIpBody({ cidr: "10.0.0.0/24" }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
    await expect(createAssetMapping(validExactIpBody({ asn: 100 }), { client })).rejects.toThrow(
      AssetMappingValidationError
    );
  });
});

describe("createAssetMapping — CIDR", () => {
  it("creates a mapping with canonical cidr and derived range", async () => {
    const client = createFakeClient();
    const mapping = await createAssetMapping(validCidrBody({ cidr: "203.0.113.5/24" }), { client });
    expect(mapping.cidr).toBe("203.0.113.0/24");
    expect(mapping.prefixLength).toBe(24);
    expect(mapping.exactIp).toBeNull();
    expect(mapping.asn).toBeNull();
  });

  it("rejects an invalid CIDR", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(validCidrBody({ cidr: "203.0.113.0/33" }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
  });
});

describe("createAssetMapping — ASN", () => {
  it("creates a mapping with a positive integer ASN", async () => {
    const client = createFakeClient();
    const mapping = await createAssetMapping(validAsnBody(), { client });
    expect(mapping.asn).toBe(64500);
    expect(mapping.exactIp).toBeNull();
    expect(mapping.cidr).toBeNull();
  });

  it("rejects zero, negative, and non-integer ASN", async () => {
    const client = createFakeClient();
    await expect(createAssetMapping(validAsnBody({ asn: 0 }), { client })).rejects.toThrow(
      AssetMappingValidationError
    );
    await expect(createAssetMapping(validAsnBody({ asn: -5 }), { client })).rejects.toThrow(
      AssetMappingValidationError
    );
    await expect(createAssetMapping(validAsnBody({ asn: 1.5 }), { client })).rejects.toThrow(
      AssetMappingValidationError
    );
  });
});

describe("createAssetMapping — common field validation", () => {
  it("rejects a missing/invalid organizationId", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(validExactIpBody({ organizationId: 0 }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("rejects an invalid confidence or source", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(validExactIpBody({ confidence: "SUPER_SURE" }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
    await expect(
      createAssetMapping(validExactIpBody({ source: "GUESS" }), { client })
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("rejects validUntil preceding validFrom", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(
        validExactIpBody({ validFrom: "2026-06-01T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" }),
        { client }
      )
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("accepts an equal validFrom/validUntil boundary as a validation concern for the resolver, not this rejection", async () => {
    const client = createFakeClient();
    const mapping = await createAssetMapping(
      validExactIpBody({ validFrom: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" }),
      { client }
    );
    expect(mapping.id).toBeDefined();
  });

  it("rejects a provenanceNote beyond the bound", async () => {
    const client = createFakeClient();
    await expect(
      createAssetMapping(
        validExactIpBody({ provenanceNote: "x".repeat(MAX_PROVENANCE_NOTE_LENGTH + 1) }),
        { client }
      )
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("accepts a provenanceNote at the bound and trims whitespace", async () => {
    const client = createFakeClient();
    const mapping = await createAssetMapping(validExactIpBody({ provenanceNote: "  hello  " }), {
      client,
    });
    expect(mapping.provenanceNote).toBe("hello");
  });
});

describe("updateAssetMapping", () => {
  it("updates confidence/provenanceNote/mappingConfirmed and stamps updatedByUserId", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client, actorUserId: 1 });
    const { before, after } = await updateAssetMapping(
      created.id,
      { confidence: "CONFIRMED", mappingConfirmed: true },
      { client, actorUserId: 2 }
    );
    expect(before.confidence).toBe("HIGH");
    expect(after.confidence).toBe("CONFIRMED");
    expect(after.mappingConfirmed).toBe(true);
    expect(after.updatedByUserId).toBe(2);
  });

  it("ignores mappingType/exactIp — identity fields are not editable", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client });
    const { after } = await updateAssetMapping(
      created.id,
      { mappingType: "ASN", exactIp: "10.0.0.1", mappingConfirmed: true },
      { client }
    );
    expect(after.mappingType).toBe("EXACT_IP");
    expect(after.exactIp).toBe("203.0.113.10");
  });

  it("rejects an update with no updatable fields", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client });
    await expect(updateAssetMapping(created.id, {}, { client })).rejects.toThrow(
      AssetMappingValidationError
    );
  });

  it("rejects validUntil preceding the existing validFrom when only validUntil is submitted", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(
      validExactIpBody({ validFrom: "2026-06-01T00:00:00Z" }),
      { client }
    );
    await expect(
      updateAssetMapping(created.id, { validUntil: "2026-01-01T00:00:00Z" }, { client })
    ).rejects.toThrow(AssetMappingValidationError);
  });

  it("throws AssetMappingNotFoundError for a nonexistent id", async () => {
    const client = createFakeClient();
    await expect(updateAssetMapping(999, { mappingConfirmed: true }, { client })).rejects.toThrow(
      AssetMappingNotFoundError
    );
  });
});

describe("disableAssetMapping", () => {
  it("disables an enabled mapping", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client });
    const { before, after, alreadyDisabled } = await disableAssetMapping(created.id, { client });
    expect(before.enabled).toBe(true);
    expect(after.enabled).toBe(false);
    expect(alreadyDisabled).toBe(false);
  });

  it("is idempotent on an already-disabled mapping", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client });
    await disableAssetMapping(created.id, { client });
    const second = await disableAssetMapping(created.id, { client });
    expect(second.alreadyDisabled).toBe(true);
    expect(second.after.enabled).toBe(false);
  });

  it("throws AssetMappingNotFoundError for a nonexistent id", async () => {
    const client = createFakeClient();
    await expect(disableAssetMapping(999, { client })).rejects.toThrow(AssetMappingNotFoundError);
  });

  it("never hard-deletes — the row remains readable after disabling", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validExactIpBody(), { client });
    await disableAssetMapping(created.id, { client });
    expect(client._rows.has(created.id)).toBe(true);
  });
});

describe("listAssetMappings — pagination and filters", () => {
  it("paginates with the default page size", async () => {
    const client = createFakeClient();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await createAssetMapping(validExactIpBody({ exactIp: `203.0.113.${i + 1}` }), { client });
    }
    const result = await listAssetMappings({}, { client });
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(result.items).toHaveLength(5);
  });

  it("bounds pageSize at MAX_PAGE_SIZE even when a larger value is requested", () => {
    const { pageSize } = resolvePagination({ pageSize: "99999" });
    expect(pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("filters by organizationId, mappingType and enabled", async () => {
    const client = createFakeClient();
    const a = await createAssetMapping(validExactIpBody({ organizationId: 1 }), { client });
    await createAssetMapping(validCidrBody({ organizationId: 2, cidr: "10.0.0.0/24" }), { client });
    await disableAssetMapping(a.id, { client });

    const byOrg = await listAssetMappings({ organizationId: "2" }, { client });
    expect(byOrg.items).toHaveLength(1);
    expect(byOrg.items[0].organizationId).toBe(2);

    const byType = await listAssetMappings({ mappingType: "CIDR" }, { client });
    expect(byType.items).toHaveLength(1);

    const disabledOnly = await listAssetMappings({ enabled: "false" }, { client });
    expect(disabledOnly.items).toHaveLength(1);
    expect(disabledOnly.items[0].id).toBe(a.id);
  });
});

describe("serializeAssetMapping / assetMappingAuditSummary", () => {
  it("never includes a raw ipStart/ipEnd BigInt in the serialized response", async () => {
    const client = createFakeClient();
    const created = await createAssetMapping(validCidrBody(), { client });
    const serialized = serializeAssetMapping(created);
    expect(serialized).not.toHaveProperty("ipStart");
    expect(serialized).not.toHaveProperty("ipEnd");
    expect(serialized.cidr).toBe("203.0.113.0/24");
    // JSON.stringify would throw if a BigInt leaked through.
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it("bounds provenanceNote in the audit summary and never leaks the raw range", () => {
    const summary = assetMappingAuditSummary({
      id: 1,
      organizationId: 1,
      mappingType: "EXACT_IP",
      exactIp: "203.0.113.10",
      cidr: null,
      prefixLength: null,
      asn: null,
      confidence: "HIGH",
      source: "MANUAL",
      provenanceNote: "x".repeat(500),
      mappingConfirmed: false,
      enabled: true,
      ipStart: 1n,
      ipEnd: 1n,
    });
    expect(summary.provenanceNote.length).toBeLessThanOrEqual(121);
    expect(summary).not.toHaveProperty("ipStart");
  });

  it("returns null for a null input", () => {
    expect(serializeAssetMapping(null)).toBeNull();
    expect(assetMappingAuditSummary(null)).toBeNull();
  });
});
