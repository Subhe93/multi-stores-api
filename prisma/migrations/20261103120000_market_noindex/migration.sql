-- M6: per-market "noindex" switch. The market stays routed (country
-- switcher, checkout) but the web serves it with robots noindex, an empty
-- sitemap and leaves it out of the other markets' hreflang lists.
ALTER TABLE "Market"
  ADD COLUMN "noindex" BOOLEAN NOT NULL DEFAULT false;
