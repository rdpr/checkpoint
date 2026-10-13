// Raster exports are derived from the checked-in SVG masters; no font or
// image-conversion dependency is needed. Run after installing Playwright Chromium.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function render(source, output, width, height = width) {
    const svg = readFileSync(publicDir + source, 'utf8');
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    return page.screenshot({ path: publicDir + output, omitBackground: true });
  }
  function ico(images) {
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
      const entry = 6 + i * 16;
      header[entry] = size;
      header[entry + 1] = size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(png.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += png.length;
    });
    return Buffer.concat([header, ...images.map(({ png }) => png)]);
  }
  for (const theme of ['light', 'dark']) {
    for (const size of [64, 192, 512, 1024])
      await render(
        `brand/mark-${theme}.svg`,
        `brand/mark-${theme}-${size}.png`,
        size,
      );
    for (const scale of [1, 2]) {
      await render(
        `brand/lockup-${theme}.svg`,
        `brand/lockup-${theme}${scale === 2 ? '@2x' : ''}.png`,
        1140 * scale,
        240 * scale,
      );
      await render(
        `brand/logo-${theme}.svg`,
        `brand/logo-${theme}${scale === 2 ? '@2x' : ''}.png`,
        1024 * scale,
        800 * scale,
      );
    }
    const icons = [];
    for (const size of [16, 32, 48]) {
      const png = await render(
        `brand/mark-${theme}.svg`,
        `brand/favicon-${theme}-${size}.png`,
        size,
      );
      icons.push({ size, png });
    }
    writeFileSync(publicDir + `brand/favicon-${theme}.ico`, ico(icons));
  }
  // A solid tile keeps the ICO fallback legible in either browser chrome theme.
  const fallback = [];
  for (const size of [16, 32, 48]) {
    const png = await render(
      'brand/app.svg',
      `brand/favicon-${size}.png`,
      size,
    );
    fallback.push({ size, png });
  }
  writeFileSync(publicDir + 'favicon.ico', ico(fallback));
  for (const size of [192, 512])
    await render('brand/app.svg', `brand/app-${size}.png`, size);
  await render('brand/app-maskable.svg', 'brand/app-maskable-512.png', 512);
  await render('brand/app.svg', 'apple-touch-icon.png', 180);
  console.log(
    'Exported transparent logos, marks, favicons, and installation icons.',
  );
} finally {
  await browser.close();
}
