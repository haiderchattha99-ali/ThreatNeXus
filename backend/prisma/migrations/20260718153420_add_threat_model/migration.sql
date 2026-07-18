-- CreateTable
CREATE TABLE "Threat" (
    "id" SERIAL NOT NULL,
    "ip" TEXT,
    "domain" TEXT,
    "hash" TEXT,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'New',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Threat_pkey" PRIMARY KEY ("id")
);
