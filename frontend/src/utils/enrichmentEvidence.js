// Turns one enrichment summary row into the two things an analyst actually
// asks after a lookup finishes: "what did this provider tell me?" and, when it
// told us nothing, "why not?".
//
// Before this existed the panel stopped at "Lookup completed", which reports
// that the pipeline worked without reporting a single thing it learned.
//
// ---------------------------------------------------------------------------
// The rules this module does not break
// ---------------------------------------------------------------------------
//   - EVERY value here comes from `row.evidence`, which the backend populated
//     from the same stored row the status was derived from. Nothing is
//     inferred, computed from another provider, or written by a model.
//   - An absent field is DROPPED, never rendered as 0 / "Unknown" / "N/A". A
//     stored 0 or false is a real answer and IS shown — `fact()` rejects only
//     null, undefined and empty strings/arrays, so the two cases stay apart.
//   - A COMPLETED lookup whose stored row has nothing worth listing says so in
//     plain words rather than showing an empty bullet list.
//   - Every non-success state gets its own sentence. NO_RECORD in particular is
//     a successful contact with a real answer ("nothing on file"), never a
//     failure, and never left as a bare status chip.
//   - No transport detail is surfaced: the backend never serializes
//     httpStatus/errorCode/errorMessage onto a summary row, so a stack trace or
//     provider body has nothing to leak through here.

import {
  ENRICHMENT_SUMMARY_STATUS,
  PROVIDER_LABELS,
  PROVIDER_PURPOSE_LABELS,
  SKIP_REASON_LABELS,
  SUMMARY_SOURCE_LABELS,
} from '../constants/findingEnrichment'
import { formatAsOf } from '../components/ui/Metric'

const providerName = (provider) => PROVIDER_LABELS[provider] || provider

/**
 * One displayable fact, or null when the field is genuinely absent.
 * `false` and `0` are real stored answers and survive on purpose.
 */
function fact(label, value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  if (Array.isArray(value) && value.length === 0) return null
  return { label, value: String(value) }
}

const yesNo = (value) => (typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null)

// --- The stored list shapes, normalized ONCE ---------------------------------
// Each returns the COMPLETE list. The preview below caps them for a table cell;
// the detail view does not, because "everything we retained" is its whole job.

// The three exposure providers each store a `services` array of the same
// shape-ish: always a port, plus one provider-specific descriptor name.
function serviceLines(services) {
  if (!Array.isArray(services)) return []
  return services
    .filter((entry) => entry && typeof entry === 'object' && entry.port)
    .map((entry) => {
      const protocol = typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : null
      const descriptor = entry.serviceName || entry.service || entry.product || null
      const port = protocol ? `${entry.port}/${protocol}` : `${entry.port}`
      return descriptor ? `${port} ${descriptor}` : port
    })
}

function stringLines(values) {
  if (!Array.isArray(values)) return []
  return values.filter((value) => typeof value === 'string' && value.trim() !== '')
}

function productLines(products) {
  if (!Array.isArray(products)) return []
  return products
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.product === 'string')
    .map((entry) => (entry.version ? `${entry.product} ${entry.version}` : entry.product))
}

// The preview's cap. Four entries plus a truthful "(+N more)" — never a silent
// truncation, because the count is what tells the reader to open the detail.
function capped(lines) {
  if (lines.length === 0) return null
  return lines.length > 4 ? `${lines.slice(0, 4).join(', ')} (+${lines.length - 4} more)` : lines.join(', ')
}

const formatServices = (services) => capped(serviceLines(services))
const formatStrings = (values) => capped(stringLines(values))
const formatProducts = (products) => capped(productLines(products))

const joinPlace = (city, country) => [city, country].filter(Boolean).join(', ') || null

// --- Vulnerability sources ---------------------------------------------------
// The `nvd` summary row is a BATCH row: its stored evidence is a list of
// per-source results (NVD, CISA KEV, FIRST EPSS), each carrying its own status.
// Only a SUCCESS may hold normalized data — the schema guarantees it — so a
// reader that wants a VALUE must ask for a successful source, never just the
// source's presence.

export const VULNERABILITY_SOURCE_LABELS = Object.freeze({
  NVD: 'NVD',
  CISA_KEV: 'CISA KEV',
  FIRST_EPSS: 'FIRST EPSS',
})

const VULNERABILITY_SOURCE_STATUS_LABELS = Object.freeze({
  SUCCESS: 'Answered',
  NOT_FOUND: 'No record for this CVE',
  RATE_LIMITED: 'Rate limited',
  TIMEOUT: 'Timed out',
  INVALID_KEY: 'Credential rejected',
  FAILED: 'Failed',
  SKIPPED_DISABLED: 'Disabled in this deployment',
  UNSUPPORTED: 'Not supported for this subject',
})

const sources = (evidence) => (Array.isArray(evidence?.sources) ? evidence.sources : [])

/** The one SUCCESSFUL result for a source, or null — never a non-SUCCESS row. */
const answeredSource = (evidence, provider) =>
  sources(evidence).find((entry) => entry?.provider === provider && entry.status === 'SUCCESS') || null

// Stored as integer TENTHS so no float is ever persisted; 98 reads as "9.8".
const cvssScore = (tenths) =>
  tenths === null || tenths === undefined ? null : (tenths / 10).toFixed(1)

// Stored as integer BASIS POINTS (0-10000); 4200 reads as "42.00%".
const basisPointsPercent = (bp) =>
  bp === null || bp === undefined ? null : `${(bp / 100).toFixed(2)}%`

// One builder per provider, each naming ONLY columns that provider's stored row
// actually has (backend/prisma/schema.prisma). A provider with no builder
// contributes no facts rather than borrowing another provider's field names.
const FACT_BUILDERS = Object.freeze({
  abuseipdb: (e) => [
    fact('Abuse confidence', e.abuseConfidenceScore === null || e.abuseConfidenceScore === undefined ? null : `${e.abuseConfidenceScore}%`),
    fact('Reports on file', e.totalReports),
    fact('Usage type', e.usageType),
    fact('ISP', e.isp),
    fact('Domain', e.domain),
    fact('Country', e.countryCode),
    fact('Whitelisted', yesNo(e.isWhitelisted)),
    fact('Last reported', formatAsOf(e.lastReportedAt)),
  ],
  censys: (e) => [
    fact('Observed services', formatServices(e.services)),
    fact('ASN', e.autonomousSystemNumber === null || e.autonomousSystemNumber === undefined ? null : `AS${e.autonomousSystemNumber}`),
    fact('AS organisation', e.autonomousSystemName),
    fact('Certificates', e.certificateCount),
  ],
  greynoise: (e) => [
    fact('Classification', e.classification),
    fact('Internet background noise', yesNo(e.noise)),
    fact('Known business service (RIOT)', yesNo(e.riot)),
    fact('Actor', e.actorName),
    fact('Last seen', e.lastSeen),
  ],
  shodan: (e) => [
    fact('Observed services', formatServices(e.services)),
    fact('Organisation', e.organization),
    fact('ISP', e.isp),
    fact('Location', joinPlace(e.city, e.country)),
    fact('Hostnames', formatStrings(e.hostnames)),
    fact('CVEs reported by Shodan', formatStrings(e.vulnerabilities)),
    fact('Last update', e.lastUpdate),
  ],
  netlas: (e) => [
    fact('Observed services', formatServices(e.services)),
    fact('Products', formatProducts(e.products)),
    fact('Organisation', e.organization),
    fact('ASN', e.asn === null || e.asn === undefined ? null : `AS${e.asn}`),
    fact('AS organisation', e.asnOrg),
    fact('Country', e.country),
    fact('Hostnames', formatStrings(e.hostnames)),
    fact('Last seen', e.lastSeen),
  ],
  nvd: (e) => [
    fact('CVSS base score', cvssScore(answeredSource(e, 'NVD')?.cvssBaseScoreTenths)),
    fact('CVSS severity', answeredSource(e, 'NVD')?.cvssSeverity),
    fact('In CISA KEV catalogue', yesNo(answeredSource(e, 'CISA_KEV')?.isKnownExploited)),
    fact('EPSS probability', basisPointsPercent(answeredSource(e, 'FIRST_EPSS')?.epssProbabilityBasisPoints)),
  ],
})

// The headline sentence for a COMPLETED row, keyed off a field that is present.
// Each falls back to a claim that is true of any successful lookup — never one
// that asserts a value the row does not carry.
const COMPLETED_SUMMARY = Object.freeze({
  abuseipdb: (name, e) =>
    e.abuseConfidenceScore === null || e.abuseConfidenceScore === undefined
      ? `${name} returned reputation data for this indicator.`
      : `${name} rates this indicator at ${e.abuseConfidenceScore}% abuse confidence.`,
  censys: (name) => `${name} returned host intelligence for this indicator.`,
  greynoise: (name, e) =>
    typeof e.classification === 'string' && e.classification.trim() !== ''
      ? `${name} classifies this indicator as "${e.classification}".`
      : `${name} has a record for this indicator.`,
  shodan: (name) => `${name} returned host and service intelligence for this indicator.`,
  netlas: (name) => `${name} returned host and service intelligence for this indicator.`,
  // Names the sources that actually answered, so "NVD" never speaks for a KEV
  // or EPSS lookup that failed inside the same batch.
  nvd: (name, e) => {
    const answered = sources(e)
      .filter((entry) => entry?.status === 'SUCCESS')
      .map((entry) => VULNERABILITY_SOURCE_LABELS[entry.provider] || entry.provider)
    return answered.length > 0
      ? `${answered.join(', ')} returned vulnerability context for this CVE.`
      : `The ${name} batch ran, but no source returned a usable answer for this CVE.`
  },
})

// Everything that is NOT a completed lookup. Keyed by summary status; the two
// entries that depend on WHY get refined from skipReason below.
const NOTHING_STORED =
  'Lookup completed and provider evidence was stored. No additional analyst-facing fields were available in this response.'

const SKIP_SENTENCES = Object.freeze({
  FRESH_RESULT_EXISTS: 'A recent result already exists, so ThreatNeXus did not spend another provider lookup.',
  PROVIDER_NOT_CONFIGURED: 'This provider is supported, but no usable credential is currently configured.',
  EXECUTION_NOT_CONFIGURED: 'This provider is supported, but no usable credential was configured when this lookup ran.',
  PROVIDER_DISABLED: 'This provider is switched off in this deployment, so the lookup was not sent.',
  EXECUTION_DISABLED: 'This provider was switched off by the time the lookup ran, so it was not sent.',
  AUTOMATIC_BUDGET_ZERO: 'The lookup was not sent because the automatic daily provider budget is set to zero.',
  MANUAL_BUDGET_ZERO: 'The lookup was not sent because the manual daily provider budget is set to zero.',
  EXECUTION_BUDGET_EXHAUSTED: 'The lookup was not sent because the configured provider budget was exhausted.',
})

/**
 * The analyst-facing reading of one enrichment summary row.
 *
 * Deterministic: same row in, same object out. No network call, no model, no
 * wall-clock read.
 *
 * @param {{provider: string, status: string, skipReason: string|null,
 *   isStale: boolean, evidence: object|null}} row a row from
 *   GET /api/findings/:id/enrichment/summary, flattened per subject
 * @returns {{summary: string, facts: Array<{label: string, value: string}>,
 *   retrievedAt: string|null}}
 */
export function summarizeProviderEvidence(row) {
  const name = providerName(row?.provider)
  const evidence = row?.evidence || null
  const empty = { summary: '', facts: [], retrievedAt: null }

  switch (row?.status) {
    case 'COMPLETED': {
      const build = FACT_BUILDERS[row.provider]
      // A vulnerability-batch row reaching COMPLETED proves the batch finished,
      // not that a per-source result exists — the backend sends no evidence for
      // it, and this says exactly that rather than implying an answer.
      const facts = build && evidence ? build(evidence).filter(Boolean).slice(0, 5) : []
      const headline = COMPLETED_SUMMARY[row.provider]
      return {
        summary: facts.length > 0 && headline ? headline(name, evidence) : NOTHING_STORED,
        facts,
        retrievedAt: formatAsOf(evidence?.queriedAt),
      }
    }
    case 'NO_RECORD':
      return {
        ...empty,
        summary: `${name} was contacted successfully, but it has no matching record for this indicator.`,
        retrievedAt: formatAsOf(evidence?.queriedAt),
      }
    case 'NO_SUBJECT':
      return {
        ...empty,
        summary:
          row.provider === 'nvd'
            ? `No qualifying CVE is associated with this finding, so ${name} was not queried.`
            : `No qualifying subject exists on this finding, so ${name} was not queried.`,
      }
    // NOT_REQUESTED deliberately adds no sentence: its own badge already says
    // exactly that, and six restatements of it on an untouched finding would
    // bury the rows that do carry an answer.
    case 'PENDING':
      return { ...empty, summary: 'This lookup is recorded and has not returned an answer yet.' }
    case 'SKIPPED':
      return {
        ...empty,
        summary:
          SKIP_SENTENCES[row.skipReason] ||
          // Falls back to the panel's own closed skip-reason vocabulary rather
          // than inventing a sentence for a reason this map has not met.
          (SKIP_REASON_LABELS[row.skipReason]
            ? `${name} was not queried — ${SKIP_REASON_LABELS[row.skipReason].toLowerCase()}.`
            : `${name} was not queried for this finding.`),
      }
    case 'RATE_LIMITED':
      return { ...empty, summary: `${name} refused the lookup because a rate limit was reached. It can be retried later.` }
    case 'AMBIGUOUS':
      return {
        ...empty,
        summary: `The lookup was sent to ${name} but no durable answer was recorded. It needs manual review and was not retried automatically.`,
      }
    case 'UNAVAILABLE':
      return { ...empty, summary: `The ${name} lookup was attempted but did not complete successfully.` }
    default:
      return empty
  }
}

// ===========================================================================
// DETAIL — everything ThreatNeXus actually retained for one lookup
// ===========================================================================
// `summarizeProviderEvidence` above is the PREVIEW: one sentence and at most
// five facts, sized for a table cell. It stays exactly as it was.
//
// This is the other half — the same stored row, uncapped and grouped by what an
// analyst is asking rather than by column order. It adds no new source of
// truth: every value still comes from `row`, which the panel already holds from
// the summary read. Opening this performs NO request of any kind.
//
// What it deliberately does NOT claim:
//   - ThreatNeXus does not retain raw upstream response bodies. No provider
//     table has a raw-response column (backend/prisma/schema.prisma says so at
//     every one of them), so this is "stored normalized evidence", never a
//     "complete API response".
//   - a provider-reported CVE is provider CONTEXT, never an analyst-verified
//     ThreatNeXus association; the group carrying them says so in words.
//   - a missing field is absent, not zero. `fact()`'s rules apply unchanged, so
//     a stored 0 or false survives and a null is dropped rather than invented.

/** A group of related evidence, or null when nothing in it was stored. */
function group(title, note, items) {
  const kept = items.filter(Boolean)
  return kept.length > 0 ? { title, note, items: kept } : null
}

/** A complete, uncapped list field. */
function listFact(label, lines) {
  return lines.length > 0 ? { label, values: lines } : null
}

const LINK_NOTE = 'Provider permalink, shown as text — ThreatNeXus never follows it for you.'

// One builder per provider. Each names ONLY the columns the read model actually
// selects for that provider, so a group can never borrow another provider's
// field names, and a column the backend deliberately withholds (httpStatus,
// errorCode, errorMessage, retryAfterSeconds, cache keys, claim tokens) has no
// name here to be rendered under.
const DETAIL_GROUPS = Object.freeze({
  abuseipdb: (e) => [
    group('Reputation', null, [
      fact('Abuse confidence', e.abuseConfidenceScore === null || e.abuseConfidenceScore === undefined ? null : `${e.abuseConfidenceScore}%`),
      fact('Reports on file', e.totalReports),
      fact('Whitelisted by AbuseIPDB', yesNo(e.isWhitelisted)),
      fact('Last reported', formatAsOf(e.lastReportedAt)),
    ]),
    group('Ownership and network', null, [
      fact('ISP', e.isp),
      fact('Domain', e.domain),
      fact('Usage type', e.usageType),
      fact('Country', e.countryCode),
    ]),
  ],
  censys: (e) => [
    group('Observed services', null, [listFact('Service', serviceLines(e.services))]),
    group('Network', null, [
      fact('AS number', e.autonomousSystemNumber === null || e.autonomousSystemNumber === undefined ? null : `AS${e.autonomousSystemNumber}`),
      fact('AS organisation', e.autonomousSystemName),
    ]),
    group('Certificates', 'Count only — Censys certificate contents and fingerprints are never stored.', [
      fact('Certificates observed', e.certificateCount),
    ]),
  ],
  greynoise: (e) => [
    group('Classification', null, [
      fact('Classification', e.classification),
      fact('Internet background noise', yesNo(e.noise)),
      fact('Known business service (RIOT)', yesNo(e.riot)),
      fact('Actor', e.actorName),
      fact('Last seen', e.lastSeen),
    ]),
    group('Provider notes', LINK_NOTE, [
      fact('Message', e.message),
      fact('Link', e.link),
    ]),
  ],
  shodan: (e) => [
    group('Observed services', null, [listFact('Service', serviceLines(e.services))]),
    group('Host identity', null, [
      listFact('Hostname', stringLines(e.hostnames)),
      fact('Organisation', e.organization),
      fact('ISP', e.isp),
    ]),
    group('Location', null, [
      fact('City', e.city),
      fact('Country', e.country),
      fact('Country code', e.countryCode),
    ]),
    group(
      'CVEs reported by Shodan',
      'Provider context only. These are not analyst-verified ThreatNeXus CVE associations and they score nothing.',
      [listFact('CVE', stringLines(e.vulnerabilities))]
    ),
    group('Record', LINK_NOTE, [
      fact('Last update', e.lastUpdate),
      fact('Link', e.link),
    ]),
  ],
  netlas: (e) => [
    group('Observed services', null, [
      listFact('Service', serviceLines(e.services)),
      listFact('Product', productLines(e.products)),
    ]),
    group('Host identity', null, [
      listFact('Hostname', stringLines(e.hostnames)),
      listFact('DNS name', stringLines(e.dnsNames)),
      fact('Organisation', e.organization),
    ]),
    group('Network', null, [
      fact('AS number', e.asn === null || e.asn === undefined ? null : `AS${e.asn}`),
      fact('AS organisation', e.asnOrg),
      fact('Country', e.country),
    ]),
    group('Certificate', 'Subject, issuer and SAN entries only — no key material is stored.', [
      fact('Subject', e.certificateSubject),
      fact('Issuer', e.certificateIssuer),
      listFact('Subject alternative name', stringLines(e.certificateSan)),
    ]),
    group('Observation window', LINK_NOTE, [
      fact('First seen', e.firstSeen),
      fact('Last seen', e.lastSeen),
      fact('Link', e.link),
    ]),
  ],
  // One group per SOURCE, not one for the batch: NVD, CISA KEV and FIRST EPSS
  // are three separate questions with three separate answers, and the batch
  // reaching COMPLETED never means all three succeeded.
  nvd: (e) => sources(e).map(vulnerabilitySourceGroup),
})

const VULNERABILITY_SOURCE_NOTES = Object.freeze({
  NVD: 'Published CVE metadata. CVSS is shown as context and is deliberately not a Risk v1 factor.',
  CISA_KEV:
    'Known-exploited catalogue context. "No" is usable negative evidence only because the catalogue itself was fetched successfully — a catalogue that could not be fetched leaves this unanswered instead.',
  FIRST_EPSS:
    'A probability of exploitation activity in the near term. Context, never proof that this CVE was exploited here.',
})

const VULNERABILITY_SOURCE_FIELDS = Object.freeze({
  NVD: (s) => [
    fact('CVE status', s.nvdCveStatus),
    fact('Description', s.englishDescription),
    fact('CVSS base score', cvssScore(s.cvssBaseScoreTenths)),
    fact('CVSS severity', s.cvssSeverity),
    fact('CVSS version', s.cvssVersion),
    listFact('CWE', stringLines(s.primaryCweIds)),
    fact('Published', formatAsOf(s.publishedAt)),
    fact('Last modified', formatAsOf(s.lastModifiedAt)),
    fact('Source identifier', s.sourceIdentifier),
  ],
  CISA_KEV: (s) => [
    fact('Known exploited', yesNo(s.isKnownExploited)),
    fact('Added to catalogue', formatAsOf(s.dateAdded)),
    fact('Remediation due', formatAsOf(s.dueDate)),
    fact('Known ransomware campaign use', s.knownRansomwareCampaignUse),
    fact('Required action', s.requiredAction),
    fact('Catalogue version', s.catalogVersion),
    fact('Catalogue released', formatAsOf(s.catalogReleasedAt)),
  ],
  FIRST_EPSS: (s) => [
    fact('Exploit probability', basisPointsPercent(s.epssProbabilityBasisPoints)),
    fact('Percentile', basisPointsPercent(s.epssPercentileBasisPoints)),
    fact('Model date', formatAsOf(s.modelDate)),
  ],
})

/**
 * One vulnerability source as its own group. Always returned, even with no
 * values: "FIRST EPSS timed out" is an answer, and dropping the group would
 * make it indistinguishable from "never asked".
 */
function vulnerabilitySourceGroup(source) {
  const label = VULNERABILITY_SOURCE_LABELS[source?.provider] || source?.provider
  const build = VULNERABILITY_SOURCE_FIELDS[source?.provider]
  return {
    title: label,
    note: VULNERABILITY_SOURCE_NOTES[source?.provider] || null,
    items: [
      fact('Source status', VULNERABILITY_SOURCE_STATUS_LABELS[source?.status] || source?.status),
      // Only a SUCCESS may carry normalized data (the schema's own rule), so a
      // non-SUCCESS source shows its status and nothing else — never a blank
      // field set implying an empty answer.
      ...(source?.status === 'SUCCESS' && build ? build(source) : []),
      fact('Retrieved', formatAsOf(source?.queriedAt)),
      fact('Fresh until', formatAsOf(source?.expiresAt)),
    ].filter(Boolean),
  }
}

// Whether the provider was reached, read straight off the CLOSED summary status
// vocabulary — the same reading the sentences above already give each state, so
// the two can never disagree. Nothing is inferred from evidence contents.
const CONTACT_BY_STATUS = Object.freeze({
  COMPLETED: 'Yes — the provider answered',
  NO_RECORD: 'Yes — the provider answered that it holds no record',
  RATE_LIMITED: 'Yes — the provider refused, citing a rate limit',
  AMBIGUOUS: 'Yes — the request was sent and no durable answer was recorded',
  UNAVAILABLE: 'Attempted — the lookup did not complete',
  PENDING: 'Not yet — this lookup is recorded and still open',
  SKIPPED: 'No — the lookup was never sent',
  NO_SUBJECT: 'No — there was no qualifying subject to ask about',
  NOT_REQUESTED: 'No — this lookup has not been requested',
})

/**
 * The full analyst-facing reading of one enrichment summary row: header,
 * provenance, and every safe stored normalized field, grouped by meaning.
 *
 * Deterministic and offline, exactly like the preview: same row in, same object
 * out; no network call, no model, no wall-clock read.
 *
 * @param {object} row the same flattened summary row the preview takes
 * @returns {{provider: string, providerLabel: string, purposeLabel: string|null,
 *   subjectValue: string|null, status: string, statusLabel: string,
 *   summary: string, retrievedAt: string|null, isStale: boolean,
 *   groups: Array<{title: string, note: string|null,
 *     items: Array<{label: string, value?: string, values?: string[]}>}>,
 *   provenance: Array<{label: string, value: string}>}}
 */
export function buildProviderEvidenceDetail(row) {
  const providerLabel = providerName(row?.provider)
  const evidence = row?.evidence || null
  const preview = summarizeProviderEvidence(row)
  const build = DETAIL_GROUPS[row?.provider]
  const groups = build && evidence ? build(evidence).filter(Boolean) : []

  return {
    provider: row?.provider || null,
    providerLabel,
    purposeLabel: PROVIDER_PURPOSE_LABELS[row?.purpose] || null,
    subjectValue: row?.subjectValue || null,
    status: row?.status || null,
    statusLabel: ENRICHMENT_SUMMARY_STATUS[row?.status]?.label || row?.status || null,
    // The same deterministic sentence the preview shows — interpretation and
    // context, never proof, and never a second, differently-worded reading.
    summary: preview.summary,
    retrievedAt: preview.retrievedAt,
    isStale: Boolean(row?.isStale),
    groups,
    provenance: [
      fact('Provider', providerLabel),
      fact('Purpose', PROVIDER_PURPOSE_LABELS[row?.purpose]),
      fact('Subject', row?.subjectValue),
      fact('Result', ENRICHMENT_SUMMARY_STATUS[row?.status]?.label),
      fact('Reason', SKIP_REASON_LABELS[row?.skipReason]),
      fact('Provider contacted', CONTACT_BY_STATUS[row?.status]),
      fact('Recorded via', SUMMARY_SOURCE_LABELS[row?.source]),
      fact('Retrieved', preview.retrievedAt),
      fact(
        'Freshness',
        // eslint-disable-next-line no-nested-ternary
        row?.isStale
          ? `No longer fresh${row.freshUntil ? ` — expired ${formatAsOf(row.freshUntil)}` : ''}`
          : row?.freshUntil
            ? `Fresh until ${formatAsOf(row.freshUntil)}`
            : null
      ),
    ].filter(Boolean),
  }
}

export default summarizeProviderEvidence
