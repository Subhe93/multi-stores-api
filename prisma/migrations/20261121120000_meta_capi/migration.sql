-- Meta Conversions API (server-side Purchase event). Additive.
-- meta_capi_token holds the ENCRYPTED access token (CryptoService envelope),
-- never the plaintext; meta_test_event_code is Meta's optional "test event
-- code" sent with every server event while the owner verifies the setup.
ALTER TABLE "Store" ADD COLUMN "meta_capi_token" TEXT;
ALTER TABLE "Store" ADD COLUMN "meta_test_event_code" VARCHAR(40);
-- Browser context captured at checkout ({ fbp?, fbc?, source_url?, ip?,
-- user_agent? }); present only when the storefront sent it.
ALTER TABLE "Order" ADD COLUMN "tracking_context" JSONB;
ALTER TABLE "KustomCheckoutSession" ADD COLUMN "tracking_context" JSONB;
