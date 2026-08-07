"use strict";

// The one allow-list every FindingAiSuggestion row must cross before it can
// reach an HTTP response. Never exposed: inputFingerprint (internal-only,
// used solely for the staleness guard).

function serializeFindingAiSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    suggestionType: row.suggestionType,
    status: row.status,
    proposedText: row.proposedText,
    evidenceReferences: row.evidenceReferences,
    providerName: row.providerName,
    providerModel: row.providerModel === undefined ? null : row.providerModel,
    promptTemplateVersion: row.promptTemplateVersion,
    reasonCode: row.reasonCode,
    requestedByUserId: row.requestedByUserId === undefined ? null : row.requestedByUserId,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
    decidedAt: row.decidedAt === undefined ? null : row.decidedAt,
    decidedByUserId: row.decidedByUserId === undefined ? null : row.decidedByUserId,
    decisionReason: row.decisionReason === undefined ? null : row.decisionReason,
    createdAt: row.createdAt,
  };
}

module.exports = { serializeFindingAiSuggestion };
