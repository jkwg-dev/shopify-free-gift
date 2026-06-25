-- CreateTable
CREATE TABLE "rate_limits" (
    "bucketKey" TEXT NOT NULL,
    "windowStart" BIGINT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("bucketKey", "windowStart")
);
