# shoes-modern — bundled kit assets

Drop the kit's images here using the **exact filenames** referenced in
`src/modules/templates/kits/shoes-modern.ts` (the `assets` map). On import,
`materialiseKitAssets` copies each present file into the store's
`uploads/template-imports/<storeId>/` and rewrites the section content to point
at it. Any filename **not** present here falls back to a generated gradient SVG
placeholder, so the kit always renders.

Expected files (replace the placeholders with real artwork anytime):

| key | file | used by |
|-----|------|---------|
| preview | `preview.jpg` | gallery card thumbnail |
| hero-1 / hero-2 | `hero-1.jpg`, `hero-2.jpg` | hero-slider |
| editorial | `editorial.jpg` | image-with-text |
| logo-1 … logo-5 | `logo-*.svg` | logo-list |
| gallery-1 … gallery-6 | `gallery-*.jpg` | gallery-slider |
| testi-1 … testi-3 | `testi-*.jpg` | testimonials avatars |
| shoe-1 … shoe-4 | `shoe-*.jpg` | demo products (Phase 5) |

Notes
- Assets are read at runtime from `<api-cwd>/assets/templates/<kitId>/`, so the
  `assets/` folder must ship with the deployment.
- Allowed extensions follow the uploads policy: `.jpg .jpeg .png .webp .svg`.
- Keep images optimised (web-sized) — they are copied verbatim.
