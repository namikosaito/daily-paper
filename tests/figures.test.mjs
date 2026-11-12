import test from 'node:test';
import assert from 'node:assert/strict';
import { reusableLicense, extractPaperSource, extractFigure, imageExtension } from '../src/figures.mjs';

test('only explicitly supported reusable licenses are accepted', () => {
  assert.equal(reusableLicense('http://creativecommons.org/licenses/by/4.0/'), 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(reusableLicense('https://creativecommons.org/publicdomain/zero/1.0/'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(reusableLicense('https://creativecommons.org/licenses/by-sa/4.0/'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  for (const href of [
    undefined, 'not a URL', 'javascript:alert(1)',
    'https://arxiv.org/licenses/nonexclusive-distrib/1.0/',
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org.example.com/licenses/by/4.0/',
  ]) assert.equal(reusableLicense(href), null);
});

test('paper source uses its actual HTML version and license', () => {
  const source = extractPaperSource(`<a href="/html/2611.10001v3">HTML</a>
    <a href="http://creativecommons.org/licenses/by/4.0/">License</a>`, 'https://arxiv.org/abs/2611.10001');
  assert.deepEqual(source, {
    htmlUrl: 'https://arxiv.org/html/2611.10001v3',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  });
  assert.deepEqual(extractPaperSource('<p>No HTML or license</p>', 'https://arxiv.org/abs/2611.10001'), {
    licenseUrl: undefined, htmlUrl: null,
  });
});

test('representative image comes from a figure, not table or logo, and stays on arXiv', () => {
  const html = `<img src="/logo.png"><figure class="ltx_table"><img src="table.png"></figure>
    <figure class="ltx_figure"><img src="https://other.example/figure.png"></figure>
    <figure class="ltx_figure"><object data="diagram.svg"></object></figure>
    <figure class="ltx_figure"><img src="2611.10001v3/overview.png">
    <figcaption>Figure 1: A <em>robot</em> overview.</figcaption></figure>`;
  assert.deepEqual(extractFigure(html, 'https://arxiv.org/html/2611.10001v3'), {
    url: 'https://arxiv.org/html/2611.10001v3/overview.png',
    caption: 'Figure 1: A robot overview.',
  });
  assert.equal(extractFigure('<figure class="ltx_figure"><img src="data:image/png;base64,abc"></figure>', 'https://arxiv.org/html/2611.10001v1'), null);
});

test('image bytes, not file extension or server MIME, determine supported format', () => {
  assert.equal(imageExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(imageExtension(Buffer.from([255, 216, 255, 1])), 'jpg');
  assert.equal(imageExtension(Buffer.from('RIFF0000WEBP')), 'webp');
  assert.throws(() => imageExtension(Buffer.from('<html>Not an image</html>')));
  assert.throws(() => imageExtension(Buffer.from('<svg></svg>')));
});
