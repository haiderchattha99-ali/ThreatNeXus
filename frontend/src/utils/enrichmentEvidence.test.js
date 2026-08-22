import { describe, it, expect } from 'vitest'

import { summarizeProviderEvidence, buildProviderEvidenceDetail } from './enrichmentEvidence'

// What these tests defend: after a lookup finishes, an analyst is told what the
// provider actually said — and every value shown is one ThreatNeXus genuinely
// stored. The failure this file exists to catch is a summary that reads as an
// answer while the underlying row held nothing, or a missing field rendered as
// 0 / "Unknown" / "N/A".

const row = (overrides = {}) => ({
  provider: 'censys',
  status: 'NOT_REQUESTED',
  skipReason: null,
  isStale: false,
  evidence: null,
  ...overrides,
})

const labels = (result) => result.facts.map((fact) => fact.label)
const valueFor = (result, label) => result.facts.find((fact) => fact.label === label)?.value

describe('a successful lookup with useful facts', () => {
  it('summarises Censys host intelligence from the stored columns', () => {
    const result = summarizeProviderEvidence(
      row({
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T10:30:00.000Z',
          services: [
            { port: 3389, protocol: 'TCP', serviceName: 'RDP' },
            { port: 443, protocol: 'TCP', serviceName: 'HTTP' },
          ],
          autonomousSystemNumber: 13335,
          autonomousSystemName: 'CLOUDFLARENET',
          certificateCount: 2,
        },
      }),
    )

    expect(result.summary).toBe('Censys returned host intelligence for this indicator.')
    expect(valueFor(result, 'Observed services')).toBe('3389/tcp RDP, 443/tcp HTTP')
    expect(valueFor(result, 'ASN')).toBe('AS13335')
    expect(valueFor(result, 'AS organisation')).toBe('CLOUDFLARENET')
    expect(valueFor(result, 'Certificates')).toBe('2')
    expect(result.retrievedAt).toBe('2026-08-19 10:30Z')
  })

  it('leads with the AbuseIPDB confidence score when the row carries one', () => {
    const result = summarizeProviderEvidence(
      row({
        provider: 'abuseipdb',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          abuseConfidenceScore: 100,
          totalReports: 412,
          usageType: 'Data Center/Web Hosting/Transit',
          isp: 'Example Hosting',
          domain: null,
          countryCode: 'NL',
          isWhitelisted: false,
          lastReportedAt: '2026-08-18T22:15:00.000Z',
        },
      }),
    )

    expect(result.summary).toBe('AbuseIPDB rates this indicator at 100% abuse confidence.')
    expect(valueFor(result, 'Abuse confidence')).toBe('100%')
    expect(valueFor(result, 'Reports on file')).toBe('412')
    // Capped at five so one provider cannot flood the row.
    expect(result.facts).toHaveLength(5)
  })

  it('keeps a stored zero and a stored false — they are answers, not absences', () => {
    const result = summarizeProviderEvidence(
      row({
        provider: 'abuseipdb',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          abuseConfidenceScore: 0,
          totalReports: 0,
          usageType: null,
          isp: null,
          domain: null,
          countryCode: null,
          isWhitelisted: false,
          lastReportedAt: null,
        },
      }),
    )

    expect(result.summary).toBe('AbuseIPDB rates this indicator at 0% abuse confidence.')
    expect(valueFor(result, 'Abuse confidence')).toBe('0%')
    expect(valueFor(result, 'Reports on file')).toBe('0')
    expect(valueFor(result, 'Whitelisted')).toBe('No')
  })

  it('names the GreyNoise classification when one is stored', () => {
    const result = summarizeProviderEvidence(
      row({
        provider: 'greynoise',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          noise: true,
          riot: false,
          classification: 'malicious',
          actorName: null,
          lastSeen: '2026-08-18',
        },
      }),
    )

    expect(result.summary).toBe('GreyNoise classifies this indicator as "malicious".')
    expect(valueFor(result, 'Internet background noise')).toBe('Yes')
    expect(valueFor(result, 'Known business service (RIOT)')).toBe('No')
  })
})

describe('a success whose stored row is missing the optional fields', () => {
  it('drops absent fields instead of printing 0, Unknown or N/A', () => {
    const result = summarizeProviderEvidence(
      row({
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T10:30:00.000Z',
          services: [],
          autonomousSystemNumber: null,
          autonomousSystemName: 'CLOUDFLARENET',
          certificateCount: null,
        },
      }),
    )

    expect(labels(result)).toEqual(['AS organisation'])
    expect(JSON.stringify(result)).not.toMatch(/Unknown|N\/A/)
  })

  it('says plainly that nothing analyst-facing was stored when no fact survives', () => {
    const result = summarizeProviderEvidence(
      row({ status: 'COMPLETED', evidence: { queriedAt: '2026-08-19T10:30:00.000Z' } }),
    )

    expect(result.facts).toEqual([])
    expect(result.summary).toMatch(/No additional analyst-facing fields were available/i)
    // Never the confident "returned host intelligence" claim with nothing behind it.
    expect(result.summary).not.toMatch(/returned host intelligence/i)
  })

  it('gives an NVD row that completed through the batch no invented per-source result', () => {
    const result = summarizeProviderEvidence(
      row({ provider: 'nvd', status: 'COMPLETED', evidence: null }),
    )

    expect(result.facts).toEqual([])
    expect(result.summary).toMatch(/No additional analyst-facing fields were available/i)
  })
})

describe('non-success states read as sentences, not codes', () => {
  it('NO_RECORD says the provider WAS reached and simply has nothing', () => {
    const result = summarizeProviderEvidence(row({ provider: 'greynoise', status: 'NO_RECORD' }))

    expect(result.summary).toBe(
      'GreyNoise was contacted successfully, but it has no matching record for this indicator.',
    )
    expect(result.summary).not.toMatch(/fail|error|404/i)
    expect(result.facts).toEqual([])
  })

  it('NO_SUBJECT on NVD says no CVE qualified, so nothing was queried', () => {
    const result = summarizeProviderEvidence(
      row({ provider: 'nvd', status: 'NO_SUBJECT', skipReason: 'NO_SUBJECT_FOR_PROVIDER' }),
    )

    expect(result.summary).toBe(
      'No qualifying CVE is associated with this finding, so NVD was not queried.',
    )
    expect(result.summary).not.toMatch(/fail|error|unavailable/i)
  })

  it('SKIPPED / FRESH_RESULT_EXISTS explains the saved lookup', () => {
    const result = summarizeProviderEvidence(
      row({ status: 'SKIPPED', skipReason: 'FRESH_RESULT_EXISTS' }),
    )

    expect(result.summary).toBe(
      'A recent result already exists, so ThreatNeXus did not spend another provider lookup.',
    )
  })

  it('SKIPPED for budget distinguishes an exhausted budget from one set to zero', () => {
    expect(
      summarizeProviderEvidence(row({ status: 'SKIPPED', skipReason: 'EXECUTION_BUDGET_EXHAUSTED' }))
        .summary,
    ).toBe('The lookup was not sent because the configured provider budget was exhausted.')

    expect(
      summarizeProviderEvidence(row({ status: 'SKIPPED', skipReason: 'MANUAL_BUDGET_ZERO' })).summary,
    ).toMatch(/manual daily provider budget is set to zero/i)
  })

  it('SKIPPED / PROVIDER_NOT_CONFIGURED names the missing credential, never the credential', () => {
    const result = summarizeProviderEvidence(
      row({ status: 'SKIPPED', skipReason: 'PROVIDER_NOT_CONFIGURED' }),
    )

    expect(result.summary).toBe(
      'This provider is supported, but no usable credential is currently configured.',
    )
  })

  it('falls back to the closed skip-reason vocabulary for a reason it has no sentence for', () => {
    const result = summarizeProviderEvidence(
      row({ status: 'SKIPPED', skipReason: 'DELEGATE_BATCH_REQUIRED' }),
    )

    expect(result.summary).toBe(
      'Censys was not queried — requires the administrator vulnerability batch.',
    )
  })

  it('UNAVAILABLE reports an attempted, incomplete lookup and dumps no internals', () => {
    const result = summarizeProviderEvidence(row({ provider: 'shodan', status: 'UNAVAILABLE' }))

    expect(result.summary).toBe('The Shodan lookup was attempted but did not complete successfully.')
    expect(result.summary).not.toMatch(/at Object\.|Error:|stack/i)
    expect(result.facts).toEqual([])
  })

  it('PENDING says recorded, not answered — and RATE_LIMITED says it can be retried', () => {
    expect(summarizeProviderEvidence(row({ status: 'PENDING' })).summary).toMatch(
      /recorded and has not returned an answer yet/i,
    )
    expect(summarizeProviderEvidence(row({ status: 'RATE_LIMITED' })).summary).toMatch(
      /rate limit was reached/i,
    )
  })

  it('adds no sentence for NOT_REQUESTED — its own badge already says exactly that', () => {
    expect(summarizeProviderEvidence(row({ status: 'NOT_REQUESTED' })).summary).toBe('')
  })
})

describe('nothing is invented', () => {
  it('never borrows another provider field set for a provider that has no builder', () => {
    const result = summarizeProviderEvidence(
      row({ provider: 'nvd', status: 'COMPLETED', evidence: { abuseConfidenceScore: 100 } }),
    )

    expect(result.facts).toEqual([])
    expect(result.summary).not.toMatch(/100/)
  })

  it('returns an empty reading for an unrecognised status rather than guessing one', () => {
    const result = summarizeProviderEvidence(row({ status: 'SOMETHING_NEW' }))

    expect(result).toEqual({ summary: '', facts: [], retrievedAt: null })
  })
})

// ===========================================================================
// buildProviderEvidenceDetail — the drawer's reading
// ===========================================================================
// What these tests defend: the detail view shows EVERYTHING ThreatNeXus stored
// for one lookup, uncapped, and still invents nothing. The failures they exist
// to catch are (a) a stored field the read model returns but the viewer silently
// drops, (b) the preview's five-fact cap leaking into the detail, and (c) a
// transport/diagnostic column being rendered as if it were evidence.

const detailItems = (result) =>
  result.groups.flatMap((group) => group.items.map((item) => item.label))
const detailValue = (result, label) =>
  result.groups.flatMap((g) => g.items).find((item) => item.label === label)?.value
const detailValues = (result, label) =>
  result.groups.flatMap((g) => g.items).find((item) => item.label === label)?.values
const provenanceValue = (result, label) =>
  result.provenance.find((item) => item.label === label)?.value

describe('the detail view exposes every stored field, not the preview subset', () => {
  it('shows all eight stored AbuseIPDB columns, keeping 0 and false intact', () => {
    const result = buildProviderEvidenceDetail(
      row({
        provider: 'abuseipdb',
        purpose: 'IOC_REPUTATION',
        subjectValue: '203.0.113.9',
        status: 'COMPLETED',
        source: 'IOC_ENRICHMENT',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          abuseConfidenceScore: 0,
          totalReports: 0,
          countryCode: 'PK',
          isp: 'Example Telecom',
          domain: 'example.pk',
          usageType: 'Fixed Line ISP',
          isWhitelisted: false,
          lastReportedAt: '2026-08-18T22:15:00.000Z',
        },
      }),
    )

    // The preview stops at five; the detail must not.
    expect(summarizeProviderEvidence(row({ provider: 'abuseipdb', status: 'COMPLETED', evidence: { abuseConfidenceScore: 0, totalReports: 0, countryCode: 'PK', isp: 'x', domain: 'y', usageType: 'z', isWhitelisted: false, lastReportedAt: '2026-08-18T22:15:00.000Z' } })).facts).toHaveLength(5)
    expect(detailItems(result)).toHaveLength(8)

    expect(detailValue(result, 'Abuse confidence')).toBe('0%')
    expect(detailValue(result, 'Reports on file')).toBe('0')
    expect(detailValue(result, 'Whitelisted by AbuseIPDB')).toBe('No')
    expect(detailValue(result, 'ISP')).toBe('Example Telecom')
    expect(detailValue(result, 'Domain')).toBe('example.pk')
    expect(detailValue(result, 'Usage type')).toBe('Fixed Line ISP')
    expect(detailValue(result, 'Country')).toBe('PK')
  })

  it('lists every Censys service rather than the preview\'s first four', () => {
    const services = Array.from({ length: 7 }, (_, i) => ({
      port: 8000 + i,
      protocol: 'TCP',
      serviceName: `SVC${i}`,
    }))
    const result = buildProviderEvidenceDetail(
      row({ status: 'COMPLETED', evidence: { services, autonomousSystemNumber: 13335, autonomousSystemName: 'CLOUDFLARENET', certificateCount: 0 } }),
    )

    expect(detailValues(result, 'Service')).toHaveLength(7)
    expect(detailValues(result, 'Service')[6]).toBe('8006/tcp SVC6')
    expect(detailValue(result, 'AS number')).toBe('AS13335')
    // A stored zero is an answer: "no certificates observed", not "unknown".
    expect(detailValue(result, 'Certificates observed')).toBe('0')
  })

  it('shows the GreyNoise link and message the preview never had room for', () => {
    const result = buildProviderEvidenceDetail(
      row({
        provider: 'greynoise',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          noise: true,
          riot: false,
          classification: 'benign',
          actorName: 'Shodan.io',
          lastSeen: '2026-08-18',
          link: 'https://viz.greynoise.io/ip/203.0.113.9',
          message: 'Success',
        },
      }),
    )

    expect(detailValue(result, 'Link')).toBe('https://viz.greynoise.io/ip/203.0.113.9')
    expect(detailValue(result, 'Message')).toBe('Success')
    expect(detailValue(result, 'Known business service (RIOT)')).toBe('No')
  })

  it('shows every stored Shodan field and marks its CVEs as provider context', () => {
    const result = buildProviderEvidenceDetail(
      row({
        provider: 'shodan',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          services: [{ port: 22, protocol: 'TCP', product: 'OpenSSH' }],
          hostnames: ['a.example.com', 'b.example.com'],
          organization: 'Example Org',
          isp: 'Example ISP',
          country: 'Pakistan',
          countryCode: 'PK',
          city: 'Islamabad',
          vulnerabilities: ['CVE-2024-6387', 'CVE-2023-38408'],
          lastUpdate: '2026-08-17T00:00:00.000Z',
          link: 'https://www.shodan.io/host/203.0.113.9',
        },
      }),
    )

    expect(detailValues(result, 'CVE')).toEqual(['CVE-2024-6387', 'CVE-2023-38408'])
    expect(detailValue(result, 'Country code')).toBe('PK')
    expect(detailValue(result, 'City')).toBe('Islamabad')
    expect(detailValue(result, 'Link')).toBe('https://www.shodan.io/host/203.0.113.9')

    const cveGroup = result.groups.find((g) => g.title === 'CVEs reported by Shodan')
    expect(cveGroup.note).toMatch(/not analyst-verified/i)
  })

  it('shows the Netlas fields the summary select previously omitted', () => {
    const result = buildProviderEvidenceDetail(
      row({
        provider: 'netlas',
        status: 'COMPLETED',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          services: [{ port: 443, protocol: 'TCP', product: 'nginx' }],
          products: [{ product: 'nginx', version: '1.18.0' }],
          hostnames: ['host.example.com'],
          dnsNames: ['dns.example.com'],
          organization: 'Example Org',
          asn: 64500,
          asnOrg: 'EXAMPLE-AS',
          country: 'PK',
          certificateSubject: 'CN=example.com',
          certificateIssuer: "CN=Example CA",
          certificateSan: ['example.com', 'www.example.com'],
          firstSeen: '2026-01-02',
          lastSeen: '2026-08-18',
          link: 'https://app.netlas.io/host/203.0.113.9',
        },
      }),
    )

    // The six fields the pre-Ticket-C select did not return.
    expect(detailValues(result, 'DNS name')).toEqual(['dns.example.com'])
    expect(detailValue(result, 'Subject')).toBe('CN=example.com')
    expect(detailValue(result, 'Issuer')).toBe('CN=Example CA')
    expect(detailValues(result, 'Subject alternative name')).toEqual(['example.com', 'www.example.com'])
    expect(detailValue(result, 'First seen')).toBe('2026-01-02')
    expect(detailValue(result, 'Link')).toBe('https://app.netlas.io/host/203.0.113.9')
  })
})

describe('NVD, CISA KEV and FIRST EPSS stay three separately-attributed answers', () => {
  const vulnerabilityRow = (sources) =>
    row({ provider: 'nvd', purpose: 'VULNERABILITY', subjectValue: 'CVE-2024-6387', status: 'COMPLETED', source: 'VULNERABILITY_ENRICHMENT', evidence: { sources } })

  it('groups each source separately and converts tenths and basis points', () => {
    const result = buildProviderEvidenceDetail(
      vulnerabilityRow([
        {
          provider: 'NVD',
          status: 'SUCCESS',
          queriedAt: '2026-08-19T09:00:00.000Z',
          expiresAt: '2026-08-26T09:00:00.000Z',
          nvdCveStatus: 'Analyzed',
          englishDescription: 'A signal handler race condition in OpenSSH.',
          cvssVersion: '3.1',
          cvssBaseScoreTenths: 98,
          cvssSeverity: 'CRITICAL',
          primaryCweIds: ['CWE-364'],
          publishedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          provider: 'CISA_KEV',
          status: 'SUCCESS',
          queriedAt: '2026-08-19T09:00:00.000Z',
          isKnownExploited: false,
          catalogVersion: '2026.08.18',
        },
        {
          provider: 'FIRST_EPSS',
          status: 'SUCCESS',
          queriedAt: '2026-08-19T09:00:00.000Z',
          epssProbabilityBasisPoints: 4200,
          epssPercentileBasisPoints: 9750,
        },
      ]),
    )

    expect(result.groups.map((g) => g.title)).toEqual(['NVD', 'CISA KEV', 'FIRST EPSS'])
    // Integer tenths, never a persisted float.
    expect(detailValue(result, 'CVSS base score')).toBe('9.8')
    expect(detailValues(result, 'CWE')).toEqual(['CWE-364'])
    // A successfully-fetched catalogue saying "no" is usable negative evidence.
    expect(detailValue(result, 'Known exploited')).toBe('No')
    // Basis points, never parseFloat.
    expect(detailValue(result, 'Exploit probability')).toBe('42.00%')
    expect(detailValue(result, 'Percentile')).toBe('97.50%')

    expect(result.groups.find((g) => g.title === 'FIRST EPSS').note).toMatch(/never proof/i)
    expect(result.groups.find((g) => g.title === 'NVD').note).toMatch(/not a Risk v1 factor/i)
  })

  it('shows a failed source as its own unanswered status, never as an empty answer', () => {
    const result = buildProviderEvidenceDetail(
      vulnerabilityRow([
        { provider: 'CISA_KEV', status: 'TIMEOUT', isKnownExploited: null, queriedAt: '2026-08-19T09:00:00.000Z' },
        { provider: 'FIRST_EPSS', status: 'RATE_LIMITED', queriedAt: '2026-08-19T09:00:00.000Z' },
      ]),
    )

    const kev = result.groups.find((g) => g.title === 'CISA KEV')
    expect(kev.items.find((i) => i.label === 'Source status').value).toBe('Timed out')
    // The catalogue was NOT read, so "not known exploited" must not appear.
    expect(kev.items.map((i) => i.label)).not.toContain('Known exploited')
    expect(result.groups.find((g) => g.title === 'FIRST EPSS').items.find((i) => i.label === 'Source status').value)
      .toBe('Rate limited')
  })

  it('names only the sources that actually answered in the headline', () => {
    const result = buildProviderEvidenceDetail(
      vulnerabilityRow([
        { provider: 'NVD', status: 'SUCCESS', cvssBaseScoreTenths: 75, cvssSeverity: 'HIGH' },
        { provider: 'CISA_KEV', status: 'FAILED' },
      ]),
    )

    expect(result.summary).toBe('NVD returned vulnerability context for this CVE.')
    expect(result.summary).not.toMatch(/CISA KEV/)
  })
})

describe('the detail view explains a lookup that returned nothing', () => {
  it('NO_RECORD keeps the contacted-successfully reading and shows the record', () => {
    const result = buildProviderEvidenceDetail(
      row({ provider: 'greynoise', status: 'NO_RECORD', source: 'ORCHESTRATION_JOB', subjectValue: '203.0.113.9' }),
    )

    expect(result.summary).toMatch(/contacted successfully/i)
    expect(result.groups).toEqual([])
    expect(provenanceValue(result, 'Provider contacted')).toMatch(/^Yes/)
    expect(provenanceValue(result, 'Result')).toBe('Nothing on file')
  })

  it('NO_SUBJECT says the provider was never asked', () => {
    const result = buildProviderEvidenceDetail(
      row({ provider: 'nvd', status: 'NO_SUBJECT', skipReason: 'NO_SUBJECT_FOR_PROVIDER', source: 'NONE' }),
    )

    expect(provenanceValue(result, 'Provider contacted')).toMatch(/^No/)
    expect(provenanceValue(result, 'Reason')).toBe('No qualifying subject on this finding')
  })

  it('a budget skip says no request was sent', () => {
    const result = buildProviderEvidenceDetail(
      row({ provider: 'shodan', status: 'SKIPPED', skipReason: 'EXECUTION_BUDGET_EXHAUSTED' }),
    )

    expect(provenanceValue(result, 'Provider contacted')).toBe('No — the lookup was never sent')
    expect(result.summary).toMatch(/budget was exhausted/i)
  })

  it('reports a stale answer as recorded-not-current', () => {
    const result = buildProviderEvidenceDetail(
      row({ provider: 'shodan', status: 'COMPLETED', isStale: true, freshUntil: '2026-08-01T00:00:00.000Z', evidence: { queriedAt: '2026-07-30T00:00:00.000Z', organization: 'Example Org' } }),
    )

    expect(result.isStale).toBe(true)
    expect(provenanceValue(result, 'Freshness')).toMatch(/No longer fresh/i)
  })
})

describe('the detail view leaks no internals and fabricates no values', () => {
  it('renders no transport, diagnostic or credential field even when one is present', () => {
    const result = buildProviderEvidenceDetail(
      row({
        provider: 'shodan',
        status: 'UNAVAILABLE',
        evidence: {
          queriedAt: '2026-08-19T09:00:00.000Z',
          organization: 'Example Org',
          // None of these are in the read model; if one ever appeared, the
          // viewer must still refuse to name it.
          httpStatus: 401,
          errorCode: 'PROVIDER_INVALID_KEY',
          errorMessage: 'Error: bad API key sk-live-1234',
          apiKey: 'sk-live-1234',
          claimToken: 'abcd',
          cacheKey: 'deadbeef',
        },
      }),
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/sk-live-1234|claimToken|cacheKey|deadbeef|httpStatus|401/)
    expect(serialized).not.toMatch(/Error:|at Object\.|stack/)
    expect(detailValue(result, 'Organisation')).toBe('Example Org')
  })

  it('drops absent fields instead of printing 0, Unknown or N/A', () => {
    const result = buildProviderEvidenceDetail(
      row({ status: 'COMPLETED', evidence: { queriedAt: '2026-08-19T10:30:00.000Z', services: [], autonomousSystemNumber: null, autonomousSystemName: 'CLOUDFLARENET', certificateCount: null } }),
    )

    expect(detailItems(result)).toEqual(['AS organisation'])
    expect(JSON.stringify(result)).not.toMatch(/Unknown|N\/A/)
  })

  it('borrows no field set for a provider with no group builder', () => {
    const result = buildProviderEvidenceDetail(
      row({ provider: 'mystery', status: 'COMPLETED', evidence: { abuseConfidenceScore: 100 } }),
    )

    expect(result.groups).toEqual([])
    expect(JSON.stringify(result.groups)).not.toMatch(/100/)
  })
})
