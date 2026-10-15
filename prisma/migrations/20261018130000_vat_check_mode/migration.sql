-- B2B app M2.5 review: record which VIES_MODE answered a consultation, so
-- rows written by the mock are never served as cached evidence in live mode.

ALTER TABLE "VatNumberCheck"
    ADD COLUMN "mode" VARCHAR(8) NOT NULL DEFAULT 'live';
