-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "suppression" TEXT NOT NULL,
    "declineEnabled" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "displayTimezone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "configVersionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiers" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "baseThresholdAmount" INTEGER NOT NULL,
    "baseThresholdCurrency" TEXT NOT NULL,
    "giftConfig" JSONB NOT NULL,

    CONSTRAINT "tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_thresholds" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "presentmentCurrency" TEXT NOT NULL,
    "manualFxRate" DOUBLE PRECISION,
    "roundingRule" TEXT NOT NULL,
    "resolvedThresholdAmount" INTEGER NOT NULL,
    "resolvedThresholdCurrency" TEXT NOT NULL,

    CONSTRAINT "market_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_code_mappings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "resolvedGiftSetHash" TEXT NOT NULL,
    "configVersionHash" TEXT NOT NULL,
    "code" TEXT,
    "discountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_code_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");

-- CreateIndex
CREATE INDEX "campaigns_shopId_idx" ON "campaigns"("shopId");

-- CreateIndex
CREATE INDEX "tiers_campaignId_idx" ON "tiers"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "market_thresholds_tierId_market_key" ON "market_thresholds"("tierId", "market");

-- CreateIndex
CREATE UNIQUE INDEX "gift_code_mappings_code_key" ON "gift_code_mappings"("code");

-- CreateIndex
CREATE INDEX "gift_code_mappings_campaignId_idx" ON "gift_code_mappings"("campaignId");

-- CreateIndex: the reusable-code minting key — concurrency arbiter for get-or-create.
CREATE UNIQUE INDEX "gift_code_mappings_minting_key" ON "gift_code_mappings"("campaignId", "tierId", "resolvedGiftSetHash", "configVersionHash");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiers" ADD CONSTRAINT "tiers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_thresholds" ADD CONSTRAINT "market_thresholds_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_code_mappings" ADD CONSTRAINT "gift_code_mappings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
