const env = require("./src/config/env");

const app = require("./src/app");

const PORT = env.PORT;

const server = app.listen(PORT, () => {
    console.log(`🚀 ThreatNeXus server running on port ${PORT}`);
});

// Phase 10A-2 — the enrichment worker.
//
// The switch is read ONCE, here, rather than inside a loop. With it off the
// module is never required, so a disabled deployment has no worker object, no
// timer and no provider in memory at all — the default-off claim is a property
// of the process, not of a branch somebody could later invert.
let enrichmentWorker = null;
if (env.ENRICHMENT_WORKER_ENABLED) {
    // eslint-disable-next-line global-require
    const { startEnrichmentWorker } = require("./src/services/enrichmentOrchestration/enrichmentWorker");
    // eslint-disable-next-line global-require
    const prisma = require("./src/config/prisma");
    enrichmentWorker = startEnrichmentWorker({ prisma });
    console.log("Enrichment worker started (ENRICHMENT_WORKER_ENABLED=true)");
}

// Drain rather than abort. A lookup that has already contacted a provider is
// never cancelled: the IOC runner releases a cancelled claim WITH a refund,
// which on a contacted row would re-open the duplicate-call window the contact
// hold exists to close.
async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down`);
    if (enrichmentWorker) {
        await enrichmentWorker.stop();
    }
    server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
