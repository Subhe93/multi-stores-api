-- Presentment currency per store. NULL keeps the platform default, so every
-- existing store is unaffected. Only INDEPENDENT stores may set it (enforced in
-- the service layer): they charge directly on the creator's own connected
-- account, whereas marketplace orders are charged on the platform account.
ALTER TABLE "Store" ADD COLUMN "currency" VARCHAR(3);
