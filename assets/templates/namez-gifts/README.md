# namez-gifts — bundled kit assets

Drop the kit's images here using the **exact filenames** referenced in
`src/modules/templates/kits/namez-gifts.ts` (the `assets` map). On import,
`materialiseKitAssets` copies each present file into the store's
`uploads/template-imports/<storeId>/` and rewrites the section content to point
at it. Any filename **not** present here falls back to a generated gradient SVG
placeholder, so the kit always renders.

The bundled photos are real product/lifestyle reference shots (personalized 3D
name gifts) re-encoded as web-sized JPEGs (longest edge ≤ 1500px).

Expected files:

| key | file | used by |
|-----|------|---------|
| preview | `preview.jpg` | gallery card thumbnail |
| hero-1 / hero-2 | `hero-1.jpg`, `hero-2.jpg` | hero-slider |
| editorial-kids | `editorial-kids.jpg` | image-with-text ("Made personal") |
| editorial-necklace | `editorial-necklace.jpg` | image-with-text ("Wear their name") |
| gallery-1 … gallery-6 | `gallery-*.jpg` | gallery-slider |
| prod-bigletter / prod-standing / prod-dalahorse / prod-keyring / prod-necklace / prod-namekids | `prod-*.jpg` | demo products |
| stud-classic / stud-soft / stud-fast / stud-price | `stud-*.jpg` | demo products (student plaques) |

Notes
- Assets are read at runtime from `<api-cwd>/assets/templates/<kitId>/`, so the
  `assets/` folder must ship with the deployment.
- Allowed extensions follow the uploads policy: `.jpg .jpeg .png .webp .svg`.
- Keep images optimised (web-sized) — they are copied verbatim.
