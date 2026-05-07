-- Apple In-App Purchase identity for hybrid IAP. All nullable so
-- existing users (Stripe-paid or free) are unaffected. Populated by
-- /api/iap/verify when the iOS app reports a successful purchase, and
-- kept fresh by /api/iap/asn-webhook when Apple sends Server
-- Notifications V2 (renewals, refunds, expirations).
ALTER TABLE "users"
  ADD COLUMN "appleOriginalTransactionId" TEXT,
  ADD COLUMN "appleProductId"             TEXT,
  ADD COLUMN "appleEnvironment"           TEXT,
  ADD COLUMN "appleExpiresAt"             TIMESTAMP(3),
  ADD COLUMN "paymentSource"              TEXT;

-- Apple's originalTransactionId is the stable per-user subscription
-- id. Unique constraint prevents two users claiming the same chain
-- (would otherwise let a refund-and-re-buy attacker grant an
-- entitlement they shouldn't have).
CREATE UNIQUE INDEX "users_appleOriginalTransactionId_key"
  ON "users"("appleOriginalTransactionId");
