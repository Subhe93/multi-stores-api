-- Cash on delivery is opt-in per store (off by default).
ALTER TABLE "Store" ADD COLUMN     "cod_enabled" BOOLEAN NOT NULL DEFAULT false;
