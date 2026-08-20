import { describe, it, expect } from 'vitest'

import { summarizeProviderEvidence } from './enrichmentEvidence'

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
