# Checkpoint logo assets

The mark is an open C with an amber point. Use the horizontal lockup in navigation and documentation, the stacked logo for larger compositions, and the mark alone for icons. All SVGs are real vector artwork; the Inter wordmark is outlined and needs no installed font.

Assets are in [`public/brand`](../public/brand). `light` means **for light backgrounds** (ink lettering); `dark` means **for dark backgrounds** (warm white lettering). Both use amber `#e7a534`. The ink is `#202b36` and warm white is `#f5f3ed`.

| Asset | SVG | Transparent PNG |
| --- | --- | --- |
| Horizontal lockup | `lockup-light.svg`, `lockup-dark.svg` | Same names with `.png` (1140 × 240) and `@2x.png` (2280 × 480) |
| Stacked logo | `logo-light.svg`, `logo-dark.svg` | Same names with `.png` (1024 × 800) and `@2x.png` (2048 × 1600) |
| Symbol | `mark-light.svg`, `mark-dark.svg` | `mark-{light,dark}-{64,192,512,1024}.png` |
| Theme-specific favicon | Use the symbol SVG | `favicon-{light,dark}-{16,32,48}.png` and multi-size `.ico` |

[`public/favicon.svg`](../public/favicon.svg) follows the browser’s light/dark color scheme. [`public/favicon.ico`](../public/favicon.ico) uses a dark tile so legacy browsers have a readable fallback in either theme. The UI logo follows the app’s selected appearance.

Installation icons use an opaque ink background: `app-192.png`, `app-512.png`, and `app-maskable-512.png`. The maskable version keeps the symbol inside the central safe area. [`public/apple-touch-icon.png`](../public/apple-touch-icon.png) is the 180px home-screen icon. These deliberately have a background because operating systems crop and composite app icons.

Keep the mark and wordmark in proportion, preserve the gap around the point, and leave clear space around the artwork. Avoid using the full wordmark at favicon sizes.

## Updating assets and demo images

The SVGs are the editable source of truth. After changing them, regenerate the raster exports with the existing development dependencies:

```sh
npx playwright install --with-deps chromium
node ops/export-brand.mjs
```

The README screenshots show the real application reviewing the [webhook delivery example](examples/webhook-delivery.md). To recapture them after UI changes:

```sh
npm run build
node --import tsx ops/capture-demo.ts
```

The capture script creates a temporary SQLite database and an ephemeral loopback server, seeds an engineer/agent review, captures both themes, and removes the disposable data. It never uses a running installation or its accounts.
