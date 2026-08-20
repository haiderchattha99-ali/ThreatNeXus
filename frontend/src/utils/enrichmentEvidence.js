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

import { PROVIDER_LABELS, SKIP_REASON_LABELS } from '../constants/findingEnrichment'
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

// The three exposure providers each store a `services` array of the same
// shape-ish: always a port, plus one provider-specific descriptor name.
function formatServices(services) {
  if (!Array.isArray(services)) return null
  const shown = services
    .filter((entry) => entry && typeof entry === 'object' && entry.port)
    .map((entry) => {
      const protocol = typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : null
      const descriptor = entry.serviceName || entry.service || entry.product || null
      const port = protocol ? `${entry.port}/${protocol}` : `${entry.port}`
      return descriptor ? `${port} ${descriptor}` : port
    })
  if (shown.length === 0) return null
  return shown.length > 4 ? `${shown.slice(0, 4).join(', ')} (+${shown.length - 4} more)` : shown.join(', ')
}

function formatStrings(values) {
  if (!Array.isArray(values)) return null
  const shown = values.filter((value) => typeof value === 'string' && value.trim() !== '')
  if (shown.length === 0) return null
  return shown.length > 4 ? `${shown.slice(0, 4).join(', ')} (+${shown.length - 4} more)` : shown.join(', ')
}

function formatProducts(products) {
  if (!Array.isArray(products)) return null
  const shown = products
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.product === 'string')
    .map((entry) => (entry.version ? `${entry.product} ${entry.version}` : entry.product))
  if (shown.length === 0) return null
  return shown.length > 4 ? `${shown.slice(0, 4).join(', ')} (+${shown.length - 4} more)` : shown.join(', ')
}

const joinPlace = (city, country) => [city, country].filter(Boolean).join(', ') || null

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

export default summarizeProviderEvidence
