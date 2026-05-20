# v1ce-nfc — bundled kit assets

Drop the kit's images here using the **exact filenames** referenced in
`src/modules/templates/kits/v1ce-nfc.ts` (the `assets` map). On import,
`materialiseKitAssets` copies each present file into the store's
`uploads/template-imports/<storeId>/` and rewrites the section content to point
at it. Any filename **not** present here falls back to a generated gradient SVG
placeholder, so the kit always renders.

The bundled photos are real product/lifestyle reference shots (smart metal NFC
cards) downloaded and re-encoded as web-sized JPEGs (longest edge ≤ 1600px).

Expected files:

| key | file | used by |
|-----|------|---------|
| preview | `preview.jpg` | gallery card thumbnail |
| hero-1 / hero-2 | `hero-1.jpg`, `hero-2.jpg` | hero-slider |
| editorial-tap | `editorial-tap.jpg` | image-with-text ("How it works") |
| editorial-steel | `editorial-steel.jpg` | image-with-text ("Stainless steel") |
| editorial-box | `editorial-box.jpg` | call-to-action (split) |
| editorial-app | `editorial-app.jpg` | (spare — digital profile shot) |
| gallery-1 … gallery-6 | `gallery-*.jpg` | gallery-slider |
| avatar-1 … avatar-4 | `avatar-*.jpg` | testimonials avatars |
| card-black-silver / card-black-gold / card-blue-silver / card-engraved | `card-*.jpg` | demo products (Phase 5) |

Notes
- Assets are read at runtime from `<api-cwd>/assets/templates/<kitId>/`, so the
  `assets/` folder must ship with the deployment.
- Allowed extensions follow the uploads policy: `.jpg .jpeg .png .webp .svg`.
- Keep images optimised (web-sized) — they are copied verbatim.
