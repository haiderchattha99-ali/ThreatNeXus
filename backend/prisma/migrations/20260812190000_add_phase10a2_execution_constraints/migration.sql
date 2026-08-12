-- Phase 10A-2 — live enrichment execution.
--
-- Additive only. Migration 20260811162611 is merged history and is NEVER
-- edited; this is the 25th migration and CI's frozen expected_migrations list
-- is updated in the same commit.
--
-- Two changes, in this order.

-- 1. A real provider outcome that could not previously be recorded.
--
-- Every provider normalizes a non-authentication 3xx/4xx response as
-- status FAILED with errorCode PROVIDER_REJECTED (iocEnrichmentTypes.js:55,
-- censysTypes.js:45, and the netlas/shodan/greynoise equivalents). Without a
-- matching AttemptOutcome, a Censys HTTP 400 could only be finalized as
-- SERVER_ERROR or TRANSPORT_ERROR — and both are false. "The provider refused
-- our request", "the provider broke" and "we never reached the provider" are
-- three different facts and the ledger must be able to tell them apart.
--
-- ALTER TYPE ... ADD VALUE is first and alone at the top of this file. On
-- PostgreSQL the new label may not be USED by other statements in the same
-- transaction; nothing here uses it, and the code that does ships separately.
ALTER TYPE "AttemptOutcome" ADD VALUE 'PROVIDER_REJECTED';

-- 2. A delegated job must always carry the delegate it waits on.
--
-- Phase 10A-1 recorded this invariant in code and asserted it per row in the
-- real-PostgreSQL suite, and its own STATE.yaml said to promote it "when 10A-2
-- next touches the migration set". Phase 10A-2 makes it load-bearing: the
-- targeted AbuseIPDB path dereferences iocEnrichmentId to decide which
-- canonical row to claim. A RUN_DELEGATED job with a NULL delegate would be a
-- job no worker can execute, that reconciliation can never finish, and that
-- holds activeLookupKey against every future ask about that subject —
-- permanently.
--
-- Safe against every row the existing application can create:
-- enrichmentRunService.resolveEligibleTarget creates a RUN_DELEGATED job only
-- on the delegate.status === "LINKED" branch, which always sets exactly one
-- delegate foreign key; every other branch creates no job at all.
--
-- Prisma cannot model CHECK constraints, so this is hand-written here and
-- re-declared in the schema.prisma comment block, exactly as the seven
-- Phase-10A-1 constraints already are. `prisma migrate diff --exit-code` stays
-- clean because Prisma cannot see it.
ALTER TABLE "ProviderLookupJob"
  ADD CONSTRAINT "provider_lookup_job_delegated_requires_delegate"
  CHECK (
    "trigger" <> 'RUN_DELEGATED'
    OR "iocEnrichmentId" IS NOT NULL
    OR "vulnerabilityEnrichmentJobId" IS NOT NULL
  );
