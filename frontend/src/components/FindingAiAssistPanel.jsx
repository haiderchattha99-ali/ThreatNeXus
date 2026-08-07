// Phase 8C.1 — the Finding AI-assistance surface: draft generation, review,
// accept/reject. Mirrors FrameworkMappingPanel.jsx's interaction pattern
// (Phase 5's AI mapping assistance) but uses the newer Phase 6 design-system
// idiom (Panel/StatusBadge/States) FindingDetail.jsx is built from, since this
// panel mounts there.
//
// ---------------------------------------------------------------------------
// What this panel is careful never to say
// ---------------------------------------------------------------------------
// A draft is a suggestion, never a finding change. There is no path in this
// component that mutates finding.status, finding.risk or anything else on the
// Finding — accepting a draft only records a human decision about the DRAFT's
// own review state. That is enforced by the backend regardless of what this
// screen does, but the screen is worded to match: "accept" never reads as
// "apply", and nowhere does a draft's text overwrite anything shown elsewhere
// on the page.
//
// ---------------------------------------------------------------------------
// Anti-automation-bias rules, same reasoning as FrameworkMappingPanel
// ---------------------------------------------------------------------------
//   - no draft is pre-selected, and there is no accept-all control
//   - each draft is reviewed with its own decision, not a bulk action
//   - a rejection reason is required before Reject is enabled
//   - decided drafts stay visible; nothing is hidden once decided
//   - a stale (EXPIRED) draft is shown as unacceptable with the reason why
//
// Every control is rendered from the caller's REAL capabilities. That is UX
// only — the backend re-checks the capability on every request regardless of
// what is rendered here, and a denied request creates no row. A 403 renders a
// DeniedState and never signs the session out (see services/api.js: only 401
// on a non-login route triggers session expiry).

import React, { useCallback, useEffect, useState } from 'react'
import { Box, Button, TextField } from '@mui/material'
import { FiSend } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { aiFindingAssistService, aiMappingService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import { Provenance } from './ui/Metric'
import { Panel, SectionLabel } from './ui/Panel'
import { StatusBadge } from './ui/StatusBadge'
import { LoadingState, ErrorState, DeniedState, EmptyState } from './ui/States'
import { AVAILABILITY, color, type } from '../theme/tokens'
import {
  AI_ADVISORY_NOTE,
  AI_DISABLED_DETAIL,
  AI_DISABLED_MESSAGE,
  AI_UNAVAILABLE_DETAIL,
  EVIDENCE_REFERENCE_LABELS,
  FINDING_AI_SUGGESTION_STATUS,
  STALE_SUGGESTION_NOTE,
  SUGGESTION_REASON_LABELS,
  SUGGESTION_TYPES,
  SUGGESTION_TYPE_HINTS,
  SUGGESTION_TYPE_LABELS,
  describeAiAssistError,
} from '../constants/findingAiAssistance'

// Maps the shared /api/ai/config response onto the same AVAILABILITY
// vocabulary the rest of the app already uses for "disabled" vs "unavailable"
// vs "available" — never a bespoke tone invented for this one panel.
function availabilityKey(aiConfig) {
  if (!aiConfig) return 'DISABLED'
  if (aiConfig.assistanceAvailable === true) return 'AVAILABLE'
  if (aiConfig.reasonCode === 'AI_PROVIDER_NOT_AVAILABLE') return 'UNAVAILABLE'
  return 'DISABLED'
}

function SuggestionCard({ suggestion, canDecide, busy, onAccept, onReject }) {
  const [reason, setReason] = useState('')
  const isDraft = suggestion.status === 'DRAFT'

  return (
    <Box
      data-testid={`ai-suggestion-${suggestion.id}`}
      sx={{
        border: `1px solid ${color.border}`,
        borderRadius: '9px',
        p: 2,
        mb: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Box component="span" sx={{ ...type.bodyStrong, color: color.text }}>
          {SUGGESTION_TYPE_LABELS[suggestion.suggestionType] || suggestion.suggestionType}
        </Box>
        <StatusBadge dictionary={FINDING_AI_SUGGESTION_STATUS} value={suggestion.status} live />
      </Box>

      {suggestion.status === 'DRAFT' ? (
        <Box sx={{ ...type.body, color: color.text, mt: 1, whiteSpace: 'pre-wrap' }}>
          {suggestion.proposedText}
        </Box>
      ) : suggestion.proposedText ? (
        <Box sx={{ ...type.body, color: color.textMuted, mt: 1, whiteSpace: 'pre-wrap' }}>
          {suggestion.proposedText}
        </Box>
      ) : (
        <Box sx={{ ...type.small, color: color.textFaint, mt: 1 }}>
          {SUGGESTION_REASON_LABELS[suggestion.reasonCode] || 'No draft text was produced.'}
        </Box>
      )}

      {suggestion.evidenceReferences?.length > 0 && (
        <Box sx={{ mt: 1.25 }}>
          <SectionLabel>Evidence used</SectionLabel>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.6 }}>
            {suggestion.evidenceReferences.map((field) => (
              <Box
                key={field}
                component="span"
                sx={{
                  ...type.caption,
                  color: color.textMuted,
                  border: `1px solid ${color.border}`,
                  borderRadius: '5px',
                  px: 0.9,
                  py: 0.2,
                }}
              >
                {EVIDENCE_REFERENCE_LABELS[field] || field}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      <Provenance
        source={`${suggestion.providerName || 'disabled'} provider · draft, not proof`}
        asOf={suggestion.requestedAt}
        sx={{ mt: 1.25 }}
      />

      {suggestion.decisionReason && (
        <Box sx={{ ...type.caption, color: color.textMuted, mt: 1 }}>
          Reviewer note: {suggestion.decisionReason}
        </Box>
      )}

      {suggestion.status === 'EXPIRED' && (
        <Box
          role="status"
          data-testid={`ai-suggestion-expired-${suggestion.id}`}
          sx={{
            ...type.caption,
            color: color.warning,
            mt: 1,
            p: 1,
            border: `1px solid ${color.warning}44`,
            borderRadius: '5px',
            backgroundColor: color.warningQuiet,
          }}
        >
          {STALE_SUGGESTION_NOTE}
        </Box>
      )}

      {isDraft && canDecide && (
        <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            aria-label={`Accept ${SUGGESTION_TYPE_LABELS[suggestion.suggestionType] || 'draft'}`}
            onClick={() => onAccept(suggestion.id)}
          >
            Accept
          </Button>
          <TextField
            size="small"
            label={`Reason to reject this draft`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            slotProps={{ htmlInput: { 'aria-label': 'Reason to reject this draft' } }}
            sx={{ minWidth: 220 }}
          />
          <Button
            size="small"
            color="warning"
            disabled={busy || reason.trim() === ''}
            aria-label={`Reject ${SUGGESTION_TYPE_LABELS[suggestion.suggestionType] || 'draft'}`}
            onClick={() => onReject(suggestion.id, reason.trim())}
          >
            Reject
          </Button>
        </Box>
      )}
    </Box>
  )
}

/**
 * The Finding-level AI-assistance surface for one Finding: availability
 * state, draft generation (role-gated), the draft list, and accept/reject
 * (role-gated, backend-enforced). No live AI provider ships with this
 * application — see constants/findingAiAssistance.js.
 */
export function FindingAiAssistPanel({ findingId }) {
  const { capabilities } = useAuth()
  const canRead = hasCapability(capabilities, CAPABILITIES.READ_AI_FINDING_SUGGESTIONS)
  const canRequest = hasCapability(capabilities, CAPABILITIES.REQUEST_AI_FINDING_SUGGESTIONS)
  const canDecide = hasCapability(capabilities, CAPABILITIES.REVIEW_AI_SUGGESTIONS)

  const [aiConfig, setAiConfig] = useState(null)
  const [suggestions, setSuggestions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [requestContext, setRequestContext] = useState('')

  const load = useCallback(async () => {
    if (!findingId || !canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(false)
    setDenied(false)
    try {
      const [configRes, suggestionsRes] = await Promise.all([
        aiMappingService.getConfig(),
        aiFindingAssistService.listSuggestions(findingId),
      ])
      setAiConfig(configRes.data?.data ?? null)
      setSuggestions(suggestionsRes.data?.data?.suggestions ?? [])
    } catch (error) {
      if (error?.response?.status === 403) {
        setDenied(true)
      } else {
        setLoadError(true)
        toast.error(describeAiAssistError(error))
      }
    } finally {
      setLoading(false)
    }
  }, [findingId, canRead])

  useEffect(() => {
    load()
  }, [load])

  const generate = async (suggestionType) => {
    setBusy(true)
    try {
      const res = await aiFindingAssistService.requestSuggestion(
        findingId,
        suggestionType,
        requestContext.trim(),
      )
      const reasonCode = res.data?.data?.reasonCode
      toast(SUGGESTION_REASON_LABELS[reasonCode] || 'The assistant has answered.')
      setRequestContext('')
      await load()
    } catch (error) {
      if (error?.response?.status === 403) {
        toast.error('You do not have access to request AI drafts.')
      } else {
        toast.error(describeAiAssistError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const accept = async (suggestionId) => {
    setBusy(true)
    try {
      const res = await aiFindingAssistService.acceptSuggestion(findingId, suggestionId)
      const outcome = res.data?.data?.outcome
      toast.success(
        outcome === 'ALREADY_DECIDED_UNCHANGED'
          ? 'That draft was already decided. Nothing changed.'
          : 'Accepted. You are recorded as the reviewer.',
      )
      await load()
    } catch (error) {
      if (error?.response?.status === 403) {
        toast.error('You do not have access to decide AI drafts.')
      } else {
        toast.error(describeAiAssistError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const reject = async (suggestionId, reason) => {
    setBusy(true)
    try {
      await aiFindingAssistService.rejectSuggestion(findingId, suggestionId, reason)
      toast.success('Rejected. The draft is kept for evaluation.')
      await load()
    } catch (error) {
      if (error?.response?.status === 403) {
        toast.error('You do not have access to decide AI drafts.')
      } else {
        toast.error(describeAiAssistError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <Panel title="AI assistance" titleLevel="h3">
        {/* No custom children: DeniedState's own fallback text names the
            missing capability explicitly (its `capability` prop is only
            rendered as part of that fallback), which is what
            findingAiAssistance.spec.js asserts on. */}
        <DeniedState capability={CAPABILITIES.READ_AI_FINDING_SUGGESTIONS} dense />
      </Panel>
    )
  }

  if (loading) {
    return (
      <Panel title="AI assistance" titleLevel="h3" data-testid="ai-assist-loading">
        <LoadingState label="Loading AI assistance" dense />
      </Panel>
    )
  }

  if (denied) {
    return (
      <Panel title="AI assistance" titleLevel="h3">
        <DeniedState capability={CAPABILITIES.READ_AI_FINDING_SUGGESTIONS} dense />
      </Panel>
    )
  }

  if (loadError) {
    return (
      <Panel title="AI assistance" titleLevel="h3">
        <ErrorState onRetry={load} dense />
      </Panel>
    )
  }

  const availability = availabilityKey(aiConfig)
  const aiAvailable = availability === 'AVAILABLE'
  const drafts = (suggestions || []).filter((row) => row.status === 'DRAFT')
  const decided = (suggestions || []).filter((row) => row.status !== 'DRAFT')

  return (
    <Panel
      title="AI assistance"
      titleLevel="h3"
      description={AI_ADVISORY_NOTE}
      data-testid="ai-assist-panel"
      actions={<StatusBadge dictionary={AVAILABILITY} value={availability} live />}
    >
      {!aiAvailable && (
        <Box sx={{ mb: 2 }} data-testid="ai-assist-unavailable">
          <Box sx={{ ...type.bodyStrong, color: color.text }}>
            {availability === 'UNAVAILABLE' ? 'No provider is configured.' : AI_DISABLED_MESSAGE}
          </Box>
          <Box sx={{ ...type.small, color: color.textMuted, mt: 0.5 }}>
            {availability === 'UNAVAILABLE' ? AI_UNAVAILABLE_DETAIL : AI_DISABLED_DETAIL}
          </Box>
        </Box>
      )}

      {canRequest && aiAvailable && (
        <Box sx={{ mb: 2 }}>
          <TextField
            fullWidth
            size="small"
            label="What should the assistant focus on? (optional)"
            value={requestContext}
            onChange={(event) => setRequestContext(event.target.value)}
            sx={{ mb: 1.25 }}
          />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {[SUGGESTION_TYPES.SUMMARY, SUGGESTION_TYPES.EXPLANATION].map((suggestionType) => (
              <Button
                key={suggestionType}
                size="small"
                variant="outlined"
                startIcon={<FiSend size={13} />}
                disabled={busy}
                aria-label={`Generate ${SUGGESTION_TYPE_LABELS[suggestionType]}`}
                title={SUGGESTION_TYPE_HINTS[suggestionType]}
                onClick={() => generate(suggestionType)}
              >
                Generate {SUGGESTION_TYPE_LABELS[suggestionType].toLowerCase()}
              </Button>
            ))}
          </Box>
        </Box>
      )}

      {drafts.length === 0 && decided.length === 0 && (
        <EmptyState title="No AI drafts yet" dense>
          {aiAvailable && canRequest
            ? 'Generate a summary or explanation draft above.'
            : 'No draft has been requested for this finding.'}
        </EmptyState>
      )}

      {drafts.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          canDecide={canDecide}
          busy={busy}
          onAccept={accept}
          onReject={reject}
        />
      ))}

      {decided.length > 0 && (
        <Box sx={{ mt: drafts.length > 0 ? 2 : 0 }} data-testid="ai-assist-decided">
          <SectionLabel sx={{ mb: 1 }}>Previously decided</SectionLabel>
          {decided.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              canDecide={false}
              busy={busy}
              onAccept={accept}
              onReject={reject}
            />
          ))}
        </Box>
      )}
    </Panel>
  )
}

export default FindingAiAssistPanel
