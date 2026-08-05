import React from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Tooltip,
} from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import {
  FiAlertTriangle,
  FiBookOpen,
  FiCheck,
  FiChevronRight,
  FiClock,
  FiExternalLink,
  FiFilter,
  FiLayers,
  FiRefreshCw,
  FiSearch,
  FiShield,
} from 'react-icons/fi'

import { attackService } from '../services/api'
import { useReducedMotion } from '../hooks/useReducedMotion'
import {
  CONFIDENCE,
  DATASET_SCOPE_NOTE,
  EVIDENCE_QUOTE_SOURCE,
  NAVIGATOR_AVAILABILITY,
  NO_COVERAGE_EXPLANATION,
  REVIEW_REASON,
  STATUS_FILTERS,
  TACTIC_STATUS,
  TECHNIQUE_STATUS,
} from '../constants/attackNavigator'
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  Provenance,
  ScopeNote,
  SectionLabel,
  StatusBadge,
  UnavailableState,
} from '../components/ui'
import { color, font, radius, type } from '../theme/tokens'

gsap.registerPlugin(useGSAP)

const INITIAL_COLUMN_LIMIT = 20

function number(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '—'
}

function RawCount({ value, label, note, icon: Icon }) {
  return (
    <Box
      data-attack-metric
      sx={{
        minWidth: 0,
        px: { xs: 1.5, md: 2 },
        py: 1.5,
        borderTop: `1px solid ${color.border}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: color.textMuted }}>
        <Icon size={13} aria-hidden="true" />
        <Box sx={type.caption}>{label}</Box>
      </Box>
      <Box sx={{ ...type.metricSm, color: color.text, mt: 0.6 }}>{number(value)}</Box>
      <Box sx={{ ...type.caption, color: color.textFaint, mt: 0.35 }}>{note}</Box>
    </Box>
  )
}

function ReviewReasonList({ reasons }) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.65 }}>
      {reasons.map((reason) => (
        <Tooltip key={reason} title={REVIEW_REASON[reason]?.description || reason} arrow>
          <Box component="span">
            <StatusBadge dictionary={REVIEW_REASON} value={reason} size="small" />
          </Box>
        </Tooltip>
      ))}
    </Box>
  )
}

function MappingEvidence({ mapping }) {
  return (
    <Box
      component="article"
      sx={{
        py: 1.6,
        '& + &': { borderTop: `1px solid ${color.border}` },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap' }}>
        <Box>
          <Button
            component={RouterLink}
            to={`/cases/${mapping.caseId}`}
            endIcon={<FiChevronRight aria-hidden="true" />}
            sx={{ px: 0, minWidth: 0, justifyContent: 'flex-start' }}
          >
            {mapping.caseReference || `Case ${mapping.caseId}`}
          </Button>
          <Box sx={{ ...type.caption, color: color.textFaint }}>
            Finding {mapping.evidenceFindingId || 'not linked'} · {mapping.source}
          </Box>
        </Box>
        <ReviewReasonList reasons={mapping.reviewReasons} />
      </Box>

      {mapping.evidenceQuote ? (
        <Box
          component="blockquote"
          sx={{
            m: 0,
            mt: 1.25,
            px: 1.5,
            py: 1.25,
            border: `1px solid ${color.borderStrong}`,
            borderRadius: `${radius.sm}px`,
            backgroundColor: color.surfaceSunken,
            color: color.text,
            ...type.small,
          }}
        >
          “{mapping.evidenceQuote}”
          <Box sx={{ mt: 0.75, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            <StatusBadge dictionary={EVIDENCE_QUOTE_SOURCE} value={mapping.evidenceQuoteSource} size="small" />
            <Box component="span" sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono }}>
              {mapping.evidenceQuoteLocator || 'legacy locator unavailable'}
            </Box>
          </Box>
        </Box>
      ) : (
        <Alert severity="warning" sx={{ mt: 1.25 }}>
          Legacy mapping. No verified evidence quote was stored when this row was recorded.
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1, mt: 1.25 }}>
        <Box>
          <SectionLabel>Evidence confidence</SectionLabel>
          <StatusBadge dictionary={CONFIDENCE} value={mapping.evidenceConfidence || 'NOT_RECORDED'} size="small" />
        </Box>
        <Box>
          <SectionLabel>Mapping confidence</SectionLabel>
          <StatusBadge dictionary={CONFIDENCE} value={mapping.mappingConfidence || 'NOT_RECORDED'} size="small" />
        </Box>
      </Box>
      <Box sx={{ ...type.caption, color: color.textMuted, mt: 1 }}>
        These two confidence statements are separate. ThreatNeXus never combines them into a score.
      </Box>
    </Box>
  )
}

function TechniqueDetail({ technique, mappings, catalogue }) {
  if (!technique) {
    return (
      <Box sx={{ minHeight: 260, display: 'grid', placeItems: 'center', px: 3, textAlign: 'center' }}>
        <Box>
          <FiBookOpen size={24} color={color.textFaint} aria-hidden="true" />
          <Box sx={{ ...type.bodyStrong, mt: 1 }}>Select a technique</Box>
          <Box sx={{ ...type.small, color: color.textMuted, mt: 0.5 }}>
            Open a matrix cell to inspect its case links, evidence quotes, validation state, and separate confidences.
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box data-technique-detail sx={{ minHeight: 260 }}>
      <Box sx={{ pb: 1.75, borderBottom: `1px solid ${color.border}` }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontFamily: font.mono, color: color.accent, ...type.bodyStrong }}>{technique.id}</Box>
            <Box component="h2" sx={{ ...type.sectionTitle, color: color.text, m: 0, mt: 0.35 }}>
              {technique.displayName || technique.name}
            </Box>
          </Box>
          <StatusBadge dictionary={TECHNIQUE_STATUS} value={technique.status} />
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1.2 }}>
          {(technique.tactics || []).map((tactic) => (
            <Chip key={tactic} label={tactic.replaceAll('-', ' ')} size="small" variant="outlined" />
          ))}
          {technique.isSubTechnique && <Chip label={`Sub-technique of ${technique.parentId}`} size="small" />}
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.75, mt: 1.5, ...type.caption, color: color.textMuted }}>
          <span>{number(technique.mappingCount)} mappings</span>
          <span>{number(technique.caseCount)} cases</span>
          <span>{number(technique.findingCount)} findings</span>
          <span>{number(technique.needsReviewCount)} need review</span>
        </Box>
        {technique.url && (
          <Button
            component="a"
            href={technique.url}
            target="_blank"
            rel="noreferrer"
            size="small"
            endIcon={<FiExternalLink aria-hidden="true" />}
            sx={{ px: 0, mt: 0.75 }}
          >
            Open MITRE technique
          </Button>
        )}
      </Box>

      {mappings.length > 0 ? (
        <Box>
          {mappings.map((mapping) => <MappingEvidence key={mapping.id} mapping={mapping} />)}
        </Box>
      ) : (
        <Box sx={{ py: 2.5 }}>
          <Box sx={{ ...type.bodyStrong }}>No mappings in the loaded dataset</Box>
          <Box sx={{ ...type.small, color: color.textMuted, mt: 0.5 }}>
            This is an observed empty state, not a gap assessment. It does not mean the technique should apply here.
          </Box>
        </Box>
      )}

      <Provenance
        source={`MITRE Enterprise ATT&CK ${catalogue?.attackVersion || 'version unavailable'}`}
        note={catalogue?.checksum ? `catalogue ${catalogue.checksum.slice(0, 12)}…` : 'catalogue checksum unavailable'}
        sx={{ pt: 1.5, borderTop: `1px solid ${color.border}` }}
      />
    </Box>
  )
}

function matchesFilter(technique, filter) {
  if (filter === 'MAPPED') return technique.mappingCount > 0
  if (filter === 'UNMAPPED') return technique.mappingCount === 0
  if (filter === 'NEEDS_REVIEW') return technique.needsReviewCount > 0
  if (filter === 'LEGACY') return technique.legacyCount > 0
  return true
}

export function AttackNavigator() {
  const rootRef = React.useRef(null)
  const [snapshot, setSnapshot] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshError, setRefreshError] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState('ALL')
  const [selectedTechniqueId, setSelectedTechniqueId] = React.useState(null)
  const [expandedTactics, setExpandedTactics] = React.useState(() => new Set())
  const reducedMotion = useReducedMotion()

  const load = React.useCallback(async () => {
    setLoading(true)
    setRefreshError(false)
    try {
      const response = await attackService.getNavigator()
      const next = response.data?.data || null
      setSnapshot(next)
      if (next?.techniques?.length) {
        setSelectedTechniqueId((current) => {
          if (current && next.techniques.some((item) => item.id === current)) return current
          return next.techniques.find((item) => item.mappingCount > 0)?.id || next.techniques[0].id
        })
      }
    } catch {
      setRefreshError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  useGSAP(() => {
    if (!snapshot || reducedMotion) return undefined
    const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } })
    timeline
      .fromTo('[data-attack-header]', { y: 12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.32, clearProps: 'transform,opacity,visibility' }, 0)
      .fromTo('[data-attack-metric]', { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.24, stagger: 0.035, clearProps: 'transform,opacity,visibility' }, 0.12)
      .fromTo('[data-attack-workspace]', { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.38, clearProps: 'transform,opacity,visibility' }, 0.26)
      .fromTo('[data-tactic-column]', { y: 12 }, { y: 0, duration: 0.28, stagger: 0.025, clearProps: 'transform' }, 0.36)
    return () => timeline.revert()
  }, { scope: rootRef, dependencies: [snapshot?.asOf, reducedMotion], revertOnUpdate: true })

  useGSAP(() => {
    if (!selectedTechniqueId || reducedMotion) return undefined
    const detail = rootRef.current?.querySelector('[data-technique-detail]')
    if (!detail) return undefined
    const tween = gsap.fromTo(detail, { x: 8, autoAlpha: 0.72 }, { x: 0, autoAlpha: 1, duration: 0.22, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })
    return () => tween.revert()
  }, { scope: rootRef, dependencies: [selectedTechniqueId, reducedMotion], revertOnUpdate: true })

  if (loading && !snapshot) return <LoadingState label="Loading the ATT&CK evidence navigator" />
  if (!snapshot) {
    return <Panel><ErrorState onRetry={load}>The navigator could not be loaded. No mapping counts are assumed.</ErrorState></Panel>
  }
  if (snapshot.availability !== 'AVAILABLE') {
    return (
      <Panel>
        <UnavailableState title="ATT&CK catalogue unavailable">
          The local catalogue did not pass its integrity check, so ThreatNeXus refused to draw a matrix.
        </UnavailableState>
      </Panel>
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const techniques = (snapshot.techniques || []).filter((technique) => {
    if (!matchesFilter(technique, statusFilter)) return false
    if (!normalizedQuery) return true
    return `${technique.id} ${technique.name} ${technique.displayName || ''}`.toLowerCase().includes(normalizedQuery)
  })
  const techniqueById = new Map((snapshot.techniques || []).map((item) => [item.id, item]))
  const selected = techniqueById.get(selectedTechniqueId) || null
  const selectedMappings = (snapshot.mappings || []).filter((mapping) => mapping.referenceId === selectedTechniqueId)

  return (
    <Box ref={rootRef}>
      <Box data-attack-header>
        <PageHeader
          eyebrow="Evidence framework"
          title="ATT&CK evidence navigator"
          description="Trace analyst-recorded techniques back to cases, findings, and verbatim evidence. Counts describe this loaded dataset only."
          actions={(
            <Button onClick={load} disabled={loading} startIcon={<FiRefreshCw aria-hidden="true" />}>
              {loading ? 'Refreshing' : 'Refresh evidence'}
            </Button>
          )}
          meta={<Provenance source="Stored framework mappings" asOf={snapshot.asOf} note={`Enterprise ATT&CK ${snapshot.catalogue?.attackVersion || 'unknown version'}`} />}
        />
      </Box>

      {refreshError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Refresh failed. The last successful timestamped navigator snapshot remains visible.
        </Alert>
      )}

      <Alert severity="info" icon={<FiShield aria-hidden="true" />} sx={{ mb: 2 }}>
        {NO_COVERAGE_EXPLANATION}
      </Alert>

      <Panel padded={false} sx={{ mb: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(5, minmax(0, 1fr))' } }}>
          <RawCount value={snapshot.totals?.activeMappings} label="Active mappings" note="Rows currently in force" icon={FiLayers} />
          <RawCount value={snapshot.totals?.mappedTechniques} label="Mapped techniques" note="Distinct technique IDs" icon={FiCheck} />
          <RawCount value={snapshot.totals?.casesWithMappings} label="Cases represented" note="Distinct mapped cases" icon={FiBookOpen} />
          <RawCount value={snapshot.totals?.needsReview} label="Needs review" note="Human review flags" icon={FiAlertTriangle} />
          <RawCount value={snapshot.totals?.casesWithNoApplicableDetermination} label="No-applicable decisions" note="Explicit analyst determinations" icon={FiShield} />
        </Box>
      </Panel>

      <Box data-attack-workspace sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1.45fr) minmax(340px, .55fr)' }, gap: 2, alignItems: 'start' }}>
        <Panel
          title="Tactic matrix"
          description="Each cell shows a raw mapping count. An empty cell means no mapping is stored in this dataset, not that the technique should be present."
          padded={false}
          actions={<StatusBadge dictionary={NAVIGATOR_AVAILABILITY} value={snapshot.availability} size="small" />}
          sx={{ minWidth: 0 }}
        >
          <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(220px, 1fr) 210px' }, gap: 1.25, borderBottom: `1px solid ${color.border}` }}>
            <TextField
              size="small"
              label="Search technique ID or name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              slotProps={{ input: { startAdornment: <FiSearch size={14} aria-hidden="true" style={{ marginRight: 8, color: color.textFaint }} /> } }}
            />
            <FormControl size="small">
              <InputLabel id="attack-status-filter-label">Filter techniques</InputLabel>
              <Select
                labelId="attack-status-filter-label"
                label="Filter techniques"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                startAdornment={<FiFilter size={13} aria-hidden="true" style={{ marginRight: 8 }} />}
              >
                {STATUS_FILTERS.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>

          <Box
            role="region"
            aria-label="MITRE ATT&CK tactic matrix"
            tabIndex={0}
            sx={{ overflowX: 'auto', pb: 1, outline: 'none', '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${color.borderFocus}` } }}
          >
            <Box sx={{ display: 'flex', alignItems: 'stretch', minWidth: 'max-content' }}>
              {(snapshot.tactics || []).map((tactic) => {
                const tacticTechniques = techniques.filter((technique) => technique.tactics.includes(tactic.shortName))
                const expanded = expandedTactics.has(tactic.shortName) || normalizedQuery || statusFilter !== 'ALL'
                const visible = expanded ? tacticTechniques : tacticTechniques.slice(0, INITIAL_COLUMN_LIMIT)
                const remaining = tacticTechniques.length - visible.length
                return (
                  <Box
                    key={tactic.id}
                    data-tactic-column
                    component="section"
                    aria-labelledby={`tactic-${tactic.shortName}`}
                    sx={{ width: 244, flex: '0 0 244px', borderRight: `1px solid ${color.border}`, '&:last-of-type': { borderRight: 0 } }}
                  >
                    <Box sx={{ position: 'sticky', top: 0, zIndex: 1, p: 1.5, minHeight: 116, backgroundColor: color.surfaceRaised, borderBottom: `1px solid ${color.border}` }}>
                      <StatusBadge dictionary={TACTIC_STATUS} value={tactic.status} size="small" />
                      <Box component="h3" id={`tactic-${tactic.shortName}`} sx={{ ...type.bodyStrong, color: color.text, m: 0, mt: 1 }}>
                        {tactic.name}
                      </Box>
                      <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.4 }}>
                        {number(tactic.mappedTechniqueCount)} mapped techniques · {number(tactic.mappingCount)} mappings
                      </Box>
                    </Box>
                    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 1, display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                      {visible.length === 0 && (
                        <Box component="li" sx={{ ...type.caption, color: color.textFaint, p: 1 }}>
                          No techniques match this filter.
                        </Box>
                      )}
                      {visible.map((technique) => {
                        const active = selectedTechniqueId === technique.id
                        return (
                          <Box component="li" key={technique.id}>
                            <Box
                              component="button"
                              type="button"
                              aria-pressed={active}
                              onClick={() => setSelectedTechniqueId(technique.id)}
                              sx={{
                                width: '100%',
                                border: `1px solid ${active ? color.accent : technique.needsReviewCount > 0 ? color.warning : color.border}`,
                                borderRadius: `${radius.sm}px`,
                                backgroundColor: active ? color.accentQuiet : color.surfaceSunken,
                                color: color.text,
                                p: 1,
                                textAlign: 'left',
                                cursor: 'pointer',
                                transition: 'transform 160ms ease, border-color 160ms ease, background-color 160ms ease',
                                '&:hover': { transform: 'translateY(-1px)', borderColor: color.borderStrong, backgroundColor: color.surfaceRaised },
                                '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 2 },
                              }}
                            >
                              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.75 }}>
                                <Box component="span" sx={{ fontFamily: font.mono, fontSize: 11, color: active ? color.accent : color.textMuted }}>
                                  {technique.id}
                                </Box>
                                <Box component="span" aria-label={`${technique.mappingCount} mappings`} sx={{ minWidth: 22, px: 0.65, py: '1px', borderRadius: `${radius.pill}px`, backgroundColor: technique.mappingCount > 0 ? color.accentQuiet : color.neutralQuiet, color: technique.mappingCount > 0 ? color.accent : color.textMuted, fontFamily: font.mono, fontSize: 10, textAlign: 'center' }}>
                                  {number(technique.mappingCount)}
                                </Box>
                              </Box>
                              <Box component="span" sx={{ display: 'block', ...type.caption, color: color.text, mt: 0.35 }}>
                                {technique.displayName || technique.name}
                              </Box>
                              {technique.needsReviewCount > 0 && (
                                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.4, ...type.caption, color: color.warning, mt: 0.45 }}>
                                  <FiClock size={10} aria-hidden="true" /> {technique.needsReviewCount} need review
                                </Box>
                              )}
                            </Box>
                          </Box>
                        )
                      })}
                      {remaining > 0 && (
                        <Box component="li">
                          <Button
                            fullWidth
                            size="small"
                            onClick={() => setExpandedTactics((current) => new Set([...current, tactic.shortName]))}
                          >
                            Show {remaining} more
                          </Button>
                        </Box>
                      )}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
        </Panel>

        <Panel
          title="Evidence detail"
          description="The selected technique’s active mappings and the records they cite."
          sx={{ position: { xl: 'sticky' }, top: { xl: 76 }, maxHeight: { xl: 'calc(100vh - 92px)' }, overflowY: { xl: 'auto' } }}
        >
          <TechniqueDetail technique={selected} mappings={selectedMappings} catalogue={snapshot.catalogue} />
        </Panel>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mt: 2 }}>
        <Panel
          title="Review queue"
          description="Mappings are flagged for human attention only. No flag changes or removes a mapping automatically."
        >
          {(snapshot.needsReview || []).length === 0 ? (
            <Box sx={{ ...type.small, color: color.textMuted }}>No active mappings are currently flagged.</Box>
          ) : (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {snapshot.needsReview.map((mapping) => (
                <Box component="li" key={mapping.id} sx={{ py: 1.25, '& + &': { borderTop: `1px solid ${color.border}` } }}>
                  <Button component={RouterLink} to={`/cases/${mapping.caseId}`} sx={{ px: 0 }}>
                    {mapping.referenceId} · {mapping.caseReference || `Case ${mapping.caseId}`}
                  </Button>
                  <ReviewReasonList reasons={mapping.reviewReasons} />
                </Box>
              ))}
            </Box>
          )}
        </Panel>

        <Panel
          title="Explicit no-applicable determinations"
          description="These cases were reviewed and an analyst recorded that no ATT&CK reference applies. This is distinct from unfinished mapping work."
        >
          {(snapshot.noApplicableAssertions || []).length === 0 ? (
            <Box sx={{ ...type.small, color: color.textMuted }}>No determinations are recorded in this dataset.</Box>
          ) : (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {snapshot.noApplicableAssertions.map((assertion) => (
                <Box component="li" key={assertion.id} sx={{ py: 1.25, '& + &': { borderTop: `1px solid ${color.border}` } }}>
                  <Button component={RouterLink} to={`/cases/${assertion.caseId}`} sx={{ px: 0 }}>
                    {assertion.caseReference || `Case ${assertion.caseId}`}
                  </Button>
                  <Box sx={{ ...type.small, color: color.text, mt: 0.25 }}>{assertion.rationale}</Box>
                </Box>
              ))}
            </Box>
          )}
        </Panel>
      </Box>

      {(snapshot.orphanedMappings || []).length > 0 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {snapshot.orphanedMappings.length} active mapping(s) cite retired or no-longer-mappable technique IDs. They remain visible in the review queue and are not silently removed.
        </Alert>
      )}

      <ScopeNote sx={{ mt: 2 }}>{DATASET_SCOPE_NOTE}</ScopeNote>
    </Box>
  )
}

export default AttackNavigator
