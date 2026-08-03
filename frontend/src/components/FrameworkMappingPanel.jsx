import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import toast from 'react-hot-toast'

import { aiMappingService, frameworkMappingService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import { formatInstant } from '../constants/caseWorkflow'
import {
  AI_ADVISORY_NOTE,
  AI_DISABLED_DETAIL,
  AI_DISABLED_MESSAGE,
  ATTACK_EVIDENCE_WARNING,
  EVIDENCE_BASES,
  EVIDENCE_BASIS_HINTS,
  EVIDENCE_BASIS_LABELS,
  FRAMEWORKS,
  FRAMEWORK_COLORS,
  FRAMEWORK_LABELS,
  FRAMEWORK_NOTES,
  FRAMEWORK_VERSION_PLACEHOLDERS,
  MAPPING_SCOPES,
  MAPPING_SCOPE_LABELS,
  MAPPING_SOURCE_LABELS,
  MAPPING_STATE_COLORS,
  MAPPING_STATE_LABELS,
  REFERENCE_PLACEHOLDERS,
  RUN_REASON_LABELS,
  STALE_SUGGESTION_NOTE,
  SUGGESTION_STATE_COLORS,
  SUGGESTION_STATE_LABELS,
  describeMappingError,
} from '../constants/frameworkMapping'

const FRAMEWORK_OPTIONS = [
  FRAMEWORKS.MITRE_ATTACK,
  FRAMEWORKS.NIST_CSF,
  FRAMEWORKS.CIS_CONTROLS,
]

const EVIDENCE_BASIS_OPTIONS = [
  EVIDENCE_BASES.OBSERVED_BEHAVIOR,
  EVIDENCE_BASES.CONTROL_GAP,
  EVIDENCE_BASES.REMEDIATION_ALIGNMENT,
  EVIDENCE_BASES.ANALYST_ASSESSMENT,
]

const EMPTY_FORM = {
  framework: FRAMEWORKS.NIST_CSF,
  frameworkVersion: '',
  referenceId: '',
  referenceTitle: '',
  mappingScope: MAPPING_SCOPES.CASE,
  evidenceBasis: EVIDENCE_BASES.CONTROL_GAP,
  rationale: '',
  evidenceFindingId: '',
}

function SubPanel({ title, subtitle, children, testId, action }) {
  return (
    <Box sx={{ mb: 3 }} data-testid={testId}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography sx={{ fontSize: 14, fontWeight: 700, color: '#EAF1F9' }}>{title}</Typography>
          {subtitle && (
            <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 0.5, maxWidth: 760 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {action}
      </Box>
      <Divider sx={{ my: 1.5, borderColor: '#243549' }} />
      {children}
    </Box>
  )
}

/**
 * The framework-mapping workspace for one case: active mappings grouped by
 * framework, the append-only history, the manual mapping form, and the optional
 * AI assistance panel.
 *
 * ---------------------------------------------------------------------------
 * What this screen is careful never to say
 * ---------------------------------------------------------------------------
 * An active mapping means an analyst associated a control with this case, on a
 * stated basis, and wrote down why. It does NOT mean the control is
 * implemented, audited or compliant, and — for ATT&CK — it does not mean a
 * technique was executed beyond what the rationale asserts.
 *
 * So there is no percentage anywhere, no coverage gauge, no maturity score and
 * no denominator. Counts are counts of MAPPINGS and are labelled as such; the
 * server's own disclaimer is rendered rather than re-worded, so the two can
 * never drift.
 *
 * ---------------------------------------------------------------------------
 * Anti-automation-bias rules, all deliberate
 * ---------------------------------------------------------------------------
 *   - no suggestion is pre-selected, and there is no accept-all control
 *   - suggestions are reviewed one at a time, each with its own decision
 *   - the evidence basis and rationale are shown BESIDE the decision buttons
 *   - a rejection reason is required before Reject is enabled
 *   - rejected suggestions stay visible; nothing is hidden once decided
 *   - a stale suggestion is shown as unapprovable with the reason why, rather
 *     than being silently dropped or failing on click
 *
 * Every control is rendered from the caller's capability list. That is UX only —
 * the backend re-checks the capability on every request regardless of what is
 * rendered here, and a denied request creates no row.
 */
export function FrameworkMappingPanel({ caseId }) {
  // See FindingTriagePanel: capabilities live on the AuthContext, not on the
  // user object that GET /api/profile returns alongside them.
  const { capabilities } = useAuth()
  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_FRAMEWORK_MAPPINGS)
  const canReadSuggestions = hasCapability(capabilities, CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS)
  const canRequestSuggestions = hasCapability(
    capabilities,
    CAPABILITIES.REQUEST_AI_MAPPING_SUGGESTIONS,
  )
  const canDecideSuggestions = hasCapability(
    capabilities,
    CAPABILITIES.DECIDE_AI_MAPPING_SUGGESTIONS,
  )

  const [mappings, setMappings] = useState(null)
  const [history, setHistory] = useState(null)
  const [aiConfig, setAiConfig] = useState(null)
  const [suggestions, setSuggestions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [removeReasons, setRemoveReasons] = useState({})
  const [rejectReasons, setRejectReasons] = useState({})
  const [requestContext, setRequestContext] = useState('')

  const load = useCallback(async () => {
    if (!caseId) return
    setLoading(true)
    try {
      // The mapping reads and the config read are safe for every role that can
      // see the case. The suggestion read is not, so it is only attempted when
      // the caller holds the capability — requesting it anyway would produce a
      // 403 toast on a screen the role is entitled to use.
      const requests = [
        frameworkMappingService.listMappings(caseId),
        frameworkMappingService.getHistory(caseId),
        aiMappingService.getConfig(),
      ]
      if (canReadSuggestions) requests.push(aiMappingService.listSuggestions(caseId))

      const [mappingsRes, historyRes, configRes, suggestionsRes] = await Promise.all(requests)
      setMappings(mappingsRes.data?.data ?? null)
      setHistory(historyRes.data?.data ?? null)
      setAiConfig(configRes.data?.data ?? null)
      setSuggestions(suggestionsRes ? (suggestionsRes.data?.data ?? null) : null)
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setLoading(false)
    }
  }, [caseId, canReadSuggestions])

  useEffect(() => {
    load()
  }, [load])

  const isAttack = form.framework === FRAMEWORKS.MITRE_ATTACK

  // The server enforces this; the form mirrors it so an analyst is not left to
  // discover the rule by having a submission refused.
  useEffect(() => {
    if (isAttack && form.evidenceBasis !== EVIDENCE_BASES.OBSERVED_BEHAVIOR) {
      setForm((previous) => ({ ...previous, evidenceBasis: EVIDENCE_BASES.OBSERVED_BEHAVIOR }))
    }
  }, [isAttack, form.evidenceBasis])

  const submitMapping = async (event) => {
    event.preventDefault()
    if (!canManage || busy) return

    const payload = {
      framework: form.framework,
      frameworkVersion: form.frameworkVersion.trim(),
      referenceId: form.referenceId.trim(),
      referenceTitle: form.referenceTitle.trim(),
      mappingScope: form.mappingScope,
      evidenceBasis: form.evidenceBasis,
      rationale: form.rationale.trim(),
    }
    if (form.mappingScope === MAPPING_SCOPES.FINDING) {
      const parsed = Number.parseInt(form.evidenceFindingId, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        toast.error('A finding-scoped mapping must name the finding it is about.')
        return
      }
      payload.evidenceFindingId = parsed
    }

    setBusy(true)
    try {
      const res = await frameworkMappingService.createMapping(caseId, payload)
      const outcome = res.data?.data?.outcome
      toast.success(
        outcome === 'REACTIVATED'
          ? 'Mapping reactivated. The removal remains in the history.'
          : outcome === 'UNCHANGED'
            ? 'That mapping is already active. Nothing was written.'
            : 'Mapping recorded.',
      )
      setForm(EMPTY_FORM)
      await load()
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setBusy(false)
    }
  }

  const removeMapping = async (mappingId) => {
    const reason = (removeReasons[mappingId] || '').trim()
    if (reason === '') {
      toast.error('Say why this mapping is being withdrawn.')
      return
    }
    setBusy(true)
    try {
      await frameworkMappingService.removeMapping(caseId, mappingId, reason)
      toast.success('Mapping removed. The original remains in the history.')
      setRemoveReasons((previous) => ({ ...previous, [mappingId]: '' }))
      await load()
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setBusy(false)
    }
  }

  // Reactivation is creation: it pre-fills the form from the removed row and
  // lets the analyst restate the rationale, because re-asserting a control
  // association deserves a fresh explanation rather than a resurrected one.
  const prefillFromRemoved = (row) => {
    setForm({
      framework: row.framework,
      frameworkVersion: row.frameworkVersion,
      referenceId: row.referenceId,
      referenceTitle: row.referenceTitle,
      mappingScope: row.mappingScope,
      evidenceBasis: row.evidenceBasis,
      rationale: '',
      evidenceFindingId: row.evidenceFindingId ? String(row.evidenceFindingId) : '',
    })
    toast('Form filled from the removed mapping. Add a rationale and save to reactivate it.')
  }

  const requestSuggestions = async () => {
    setBusy(true)
    try {
      const res = await aiMappingService.requestSuggestions(caseId, requestContext.trim())
      const data = res.data?.data
      const message = RUN_REASON_LABELS[data?.reasonCode] || 'The assistant has answered.'
      if (data?.status === 'COMPLETED' && data.suggestionCount > 0) toast.success(message)
      else toast(message)
      setRequestContext('')
      await load()
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setBusy(false)
    }
  }

  const approveSuggestion = async (suggestionId) => {
    setBusy(true)
    try {
      const res = await aiMappingService.approveSuggestion(caseId, suggestionId)
      const outcome = res.data?.data?.outcome
      toast.success(
        outcome === 'ALREADY_DECIDED_UNCHANGED'
          ? 'That suggestion was already decided. Nothing changed.'
          : 'Approved. You are recorded as the analyst who made this mapping.',
      )
      await load()
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setBusy(false)
    }
  }

  const rejectSuggestion = async (suggestionId) => {
    const reason = (rejectReasons[suggestionId] || '').trim()
    if (reason === '') {
      toast.error('A rejection reason is required.')
      return
    }
    setBusy(true)
    try {
      await aiMappingService.rejectSuggestion(caseId, suggestionId, reason)
      toast.success('Rejected. The suggestion is kept for evaluation.')
      setRejectReasons((previous) => ({ ...previous, [suggestionId]: '' }))
      await load()
    } catch (error) {
      toast.error(describeMappingError(error))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }} data-testid="framework-loading">
        <CircularProgress size={22} />
      </Box>
    )
  }

  const groups = mappings?.groups ?? []
  const pending = (suggestions?.suggestions ?? []).filter((row) => row.state === 'PENDING')
  const decided = (suggestions?.suggestions ?? []).filter((row) => row.state !== 'PENDING')
  const aiAvailable = aiConfig?.assistanceAvailable === true

  return (
    <Box data-testid="framework-mapping-panel">
      {/* Rendered from the SERVER's own wording, never re-phrased here, so the
          caveat and the rule it describes cannot drift apart. */}
      <Alert severity="info" sx={{ mb: 2 }} data-testid="framework-disclaimer">
        <Typography sx={{ fontSize: 12 }}>{mappings?.disclaimer}</Typography>
        <Typography sx={{ fontSize: 12, mt: 0.5, opacity: 0.85 }}>
          {mappings?.catalogueNote}
        </Typography>
      </Alert>

      <SubPanel
        title="Active framework mappings"
        subtitle={`${mappings?.activeCount ?? 0} active mapping${
          mappings?.activeCount === 1 ? '' : 's'
        } on this case. This is a count of mappings recorded by analysts — it is not a coverage, completeness or compliance figure.`}
        testId="active-mappings"
        action={
          <Button size="small" onClick={() => setShowHistory((value) => !value)}>
            {showHistory ? 'Hide history' : 'Show history'}
          </Button>
        }
      >
        {groups.length === 0 && (
          <Typography sx={{ fontSize: 13, color: '#9DAFC2' }} data-testid="no-active-mappings">
            No framework mappings have been recorded on this case.
          </Typography>
        )}

        {groups.map((group) => (
          <Box key={group.framework} sx={{ mb: 2.5 }} data-testid={`group-${group.framework}`}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Chip
                size="small"
                label={FRAMEWORK_LABELS[group.framework] || group.framework}
                sx={{ bgcolor: FRAMEWORK_COLORS[group.framework], color: '#0b1220', fontWeight: 700 }}
              />
              <Typography sx={{ fontSize: 12, color: '#9DAFC2' }}>
                {group.count} mapping{group.count === 1 ? '' : 's'} recorded
              </Typography>
            </Box>
            <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 0.5, maxWidth: 760 }}>
              {FRAMEWORK_NOTES[group.framework]}
            </Typography>

            <TableContainer sx={{ mt: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Reference</TableCell>
                    <TableCell>Scope</TableCell>
                    <TableCell>Basis</TableCell>
                    <TableCell>Rationale</TableCell>
                    <TableCell>Source</TableCell>
                    {canManage && <TableCell>Withdraw</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {group.mappings.map((mapping) => (
                    <TableRow key={mapping.id} data-testid={`mapping-${mapping.id}`}>
                      <TableCell>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                          {mapping.referenceId}
                        </Typography>
                        <Typography sx={{ fontSize: 12, color: '#9DAFC2' }}>
                          {mapping.referenceTitle}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#9DAFC2' }}>
                          {mapping.frameworkVersion} · analyst-entered, not catalogue-verified
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>
                        {MAPPING_SCOPE_LABELS[mapping.mappingScope]}
                        {mapping.evidenceFindingId ? ` (finding ${mapping.evidenceFindingId})` : ''}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>
                        {EVIDENCE_BASIS_LABELS[mapping.evidenceBasis]}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, maxWidth: 320 }}>{mapping.rationale}</TableCell>
                      <TableCell sx={{ fontSize: 12 }}>
                        {MAPPING_SOURCE_LABELS[mapping.source]}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <TextField
                            size="small"
                            label={`Reason to withdraw ${mapping.referenceId}`}
                            value={removeReasons[mapping.id] || ''}
                            onChange={(event) =>
                              setRemoveReasons((previous) => ({
                                ...previous,
                                [mapping.id]: event.target.value,
                              }))
                            }
                            sx={{ mb: 0.5, minWidth: 180 }}
                          />
                          <Button
                            size="small"
                            color="warning"
                            disabled={busy}
                            onClick={() => removeMapping(mapping.id)}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        ))}
      </SubPanel>

      {showHistory && (
        <SubPanel
          title="Mapping history"
          subtitle="Append-only. Removing a mapping records a withdrawal; it never erases what was previously asserted."
          testId="mapping-history"
        >
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>When</TableCell>
                  <TableCell>Framework</TableCell>
                  <TableCell>Reference</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Source</TableCell>
                  <TableCell>Note</TableCell>
                  {canManage && <TableCell>Reactivate</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {(history?.history ?? []).map((row) => (
                  <TableRow key={row.id} data-testid={`history-${row.id}`}>
                    <TableCell sx={{ fontSize: 12 }}>{formatInstant(row.effectiveAt)}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>
                      {FRAMEWORK_LABELS[row.framework] || row.framework}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{row.referenceId}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={MAPPING_STATE_LABELS[row.state]}
                        sx={{ bgcolor: MAPPING_STATE_COLORS[row.state], color: '#0b1220' }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{MAPPING_SOURCE_LABELS[row.source]}</TableCell>
                    <TableCell sx={{ fontSize: 12, maxWidth: 280 }}>{row.rationale}</TableCell>
                    {canManage && (
                      <TableCell>
                        {row.state === 'REMOVED' && row.isCurrent && (
                          <Button size="small" onClick={() => prefillFromRemoved(row)}>
                            Reactivate
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </SubPanel>
      )}

      {canManage && (
        <SubPanel
          title="Record a framework mapping"
          subtitle="Associates a framework reference with this case. Saving records you as the analyst who made the association."
          testId="mapping-form"
        >
          {isAttack && (
            <Alert severity="warning" sx={{ mb: 2 }} data-testid="attack-warning">
              <Typography sx={{ fontSize: 12 }}>{ATTACK_EVIDENCE_WARNING}</Typography>
            </Alert>
          )}

          <Box component="form" onSubmit={submitMapping}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
              <TextField
                select
                size="small"
                label="Framework"
                value={form.framework}
                onChange={(event) => setForm({ ...form, framework: event.target.value })}
              >
                {FRAMEWORK_OPTIONS.map((value) => (
                  <MenuItem key={value} value={value}>
                    {FRAMEWORK_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                size="small"
                label="Framework version"
                required
                placeholder={FRAMEWORK_VERSION_PLACEHOLDERS[form.framework]}
                helperText="Required. State which version you mapped against — it is never assumed."
                value={form.frameworkVersion}
                onChange={(event) => setForm({ ...form, frameworkVersion: event.target.value })}
              />

              <TextField
                size="small"
                label="Reference id"
                required
                placeholder={REFERENCE_PLACEHOLDERS[form.framework]}
                helperText="Format-checked only. This system pins no catalogue and cannot confirm the reference exists."
                value={form.referenceId}
                onChange={(event) => setForm({ ...form, referenceId: event.target.value })}
              />

              <TextField
                size="small"
                label="Reference title"
                required
                value={form.referenceTitle}
                onChange={(event) => setForm({ ...form, referenceTitle: event.target.value })}
              />

              <TextField
                select
                size="small"
                label="Scope"
                value={form.mappingScope}
                onChange={(event) => setForm({ ...form, mappingScope: event.target.value })}
              >
                {[MAPPING_SCOPES.CASE, MAPPING_SCOPES.FINDING].map((value) => (
                  <MenuItem key={value} value={value}>
                    {MAPPING_SCOPE_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                select
                size="small"
                label="Evidence basis"
                value={form.evidenceBasis}
                // The server refuses anything but OBSERVED_BEHAVIOR for ATT&CK.
                // Locking the control mirrors the rule instead of letting an
                // analyst discover it through a rejection.
                disabled={isAttack}
                helperText={
                  isAttack
                    ? 'MITRE ATT&CK requires observed behaviour.'
                    : EVIDENCE_BASIS_HINTS[form.evidenceBasis]
                }
                onChange={(event) => setForm({ ...form, evidenceBasis: event.target.value })}
              >
                {EVIDENCE_BASIS_OPTIONS.map((value) => (
                  <MenuItem key={value} value={value}>
                    {EVIDENCE_BASIS_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>

              {form.mappingScope === MAPPING_SCOPES.FINDING && (
                <TextField
                  size="small"
                  label="Evidence finding id"
                  required
                  helperText="Must be a finding currently linked to this case."
                  value={form.evidenceFindingId}
                  onChange={(event) => setForm({ ...form, evidenceFindingId: event.target.value })}
                />
              )}
            </Box>

            <TextField
              fullWidth
              multiline
              minRows={3}
              size="small"
              sx={{ mt: 2 }}
              label="Rationale"
              required
              helperText={
                isAttack
                  ? 'Describe the behaviour that was observed, logged or reported. Exposure and vulnerability signals alone will be refused.'
                  : 'Explain why this reference belongs on this case.'
              }
              value={form.rationale}
              onChange={(event) => setForm({ ...form, rationale: event.target.value })}
            />

            <Button type="submit" variant="contained" sx={{ mt: 2 }} disabled={busy}>
              Save mapping
            </Button>
          </Box>
        </SubPanel>
      )}

      {canReadSuggestions && (
        <SubPanel
          title="AI mapping assistance"
          subtitle={AI_ADVISORY_NOTE}
          testId="ai-panel"
          action={
            canRequestSuggestions && aiAvailable ? (
              <Button size="small" variant="outlined" disabled={busy} onClick={requestSuggestions}>
                Request suggestions
              </Button>
            ) : null
          }
        >
          {!aiAvailable && (
            <Alert severity="info" data-testid="ai-disabled">
              <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{AI_DISABLED_MESSAGE}</Typography>
              <Typography sx={{ fontSize: 12, mt: 0.5 }}>{AI_DISABLED_DETAIL}</Typography>
              {aiConfig?.reasonCode && (
                <Typography sx={{ fontSize: 12, mt: 0.5, opacity: 0.85 }}>
                  {RUN_REASON_LABELS[aiConfig.reasonCode] || aiConfig.reasonCode}
                </Typography>
              )}
            </Alert>
          )}

          {aiAvailable && canRequestSuggestions && (
            <TextField
              fullWidth
              size="small"
              sx={{ mb: 2 }}
              label="What should the assistant focus on? (optional)"
              value={requestContext}
              onChange={(event) => setRequestContext(event.target.value)}
            />
          )}

          {aiAvailable && pending.length === 0 && (
            <Typography sx={{ fontSize: 13, color: '#9DAFC2' }} data-testid="no-pending-suggestions">
              No suggestions are awaiting a decision.
            </Typography>
          )}

          {/* One suggestion at a time, each with its own decision. There is no
              accept-all control and nothing is pre-selected. */}
          {pending.map((suggestion) => (
            <Box
              key={suggestion.id}
              data-testid={`suggestion-${suggestion.id}`}
              sx={{ border: '1px solid #243549', borderRadius: 1, p: 2, mb: 2 }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip
                  size="small"
                  label={FRAMEWORK_LABELS[suggestion.framework] || suggestion.framework}
                  sx={{
                    bgcolor: FRAMEWORK_COLORS[suggestion.framework],
                    color: '#0b1220',
                    fontWeight: 700,
                  }}
                />
                <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                  {suggestion.referenceId}
                </Typography>
                <Typography sx={{ fontSize: 12, color: '#9DAFC2' }}>
                  {suggestion.referenceTitle}
                </Typography>
                <Chip
                  size="small"
                  label={SUGGESTION_STATE_LABELS[suggestion.state]}
                  sx={{ bgcolor: SUGGESTION_STATE_COLORS[suggestion.state], color: '#0b1220' }}
                />
              </Box>

              <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 1 }}>
                {suggestion.frameworkVersion} · {MAPPING_SCOPE_LABELS[suggestion.mappingScope]} ·{' '}
                {EVIDENCE_BASIS_LABELS[suggestion.evidenceBasis]}
                {/* Provider self-report, labelled as such. Nothing in this
                    system reads it to decide anything. */}
                {suggestion.providerConfidence !== null &&
                  ` · model-reported confidence ${suggestion.providerConfidence}/100 (the model's own claim, not an assessment by this system)`}
              </Typography>

              {/* Evidence beside the decision, never behind a click. */}
              <Typography sx={{ fontSize: 13, mt: 1 }}>{suggestion.rationale}</Typography>

              {suggestion.staleForApproval ? (
                <Alert severity="warning" sx={{ mt: 1.5 }} data-testid={`stale-${suggestion.id}`}>
                  <Typography sx={{ fontSize: 12 }}>{STALE_SUGGESTION_NOTE}</Typography>
                </Alert>
              ) : null}

              {canDecideSuggestions && (
                <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy || suggestion.staleForApproval}
                    onClick={() => approveSuggestion(suggestion.id)}
                  >
                    Approve and map
                  </Button>
                  <TextField
                    size="small"
                    label={`Reason to reject ${suggestion.referenceId}`}
                    value={rejectReasons[suggestion.id] || ''}
                    onChange={(event) =>
                      setRejectReasons((previous) => ({
                        ...previous,
                        [suggestion.id]: event.target.value,
                      }))
                    }
                    sx={{ minWidth: 240 }}
                  />
                  <Button
                    size="small"
                    color="warning"
                    disabled={busy || (rejectReasons[suggestion.id] || '').trim() === ''}
                    onClick={() => rejectSuggestion(suggestion.id)}
                  >
                    Reject
                  </Button>
                </Box>
              )}
            </Box>
          ))}

          {/* Decided suggestions stay visible. Hiding what was refused would
              make the rejection rate — the only real evidence of whether the
              gates and the assistant are any good — invisible. */}
          {decided.length > 0 && (
            <Box sx={{ mt: 2 }} data-testid="decided-suggestions">
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 1 }}>
                Previously decided
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Framework</TableCell>
                      <TableCell>Reference</TableCell>
                      <TableCell>Decision</TableCell>
                      <TableCell>Reason</TableCell>
                      <TableCell>Decided</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {decided.map((row) => (
                      <TableRow key={row.id} data-testid={`decided-${row.id}`}>
                        <TableCell sx={{ fontSize: 12 }}>
                          {FRAMEWORK_LABELS[row.framework] || row.framework}
                        </TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{row.referenceId}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={SUGGESTION_STATE_LABELS[row.state]}
                            sx={{ bgcolor: SUGGESTION_STATE_COLORS[row.state], color: '#0b1220' }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontSize: 12, maxWidth: 260 }}>
                          {row.decisionReason || '—'}
                        </TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{formatInstant(row.decidedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
        </SubPanel>
      )}
    </Box>
  )
}

export default FrameworkMappingPanel
