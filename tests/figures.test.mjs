import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reusableLicense, extractPaperSource, extractFigure, extractPublisherSource,
  permitsScholarlyFigures, imageExtension,
} from '../src/figures.mjs';

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

test('publisher fallback requires a matching title and a paper-specific reusable license', () => {
  const paper = { id: '1810.04805', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding' };
  const html = `<meta name="citation_title" content="${paper.title}">
    <meta name="citation_pdf_url" content="https://aclanthology.org/N19-1423.pdf">
    <a rel="license" href="http://creativecommons.org/licenses/by/4.0/">License</a>`;
  assert.deepEqual(extractPublisherSource(html, paper), {
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', pdfUrl: 'https://aclanthology.org/N19-1423.pdf',
  });
  assert.equal(extractPublisherSource(html.replace('rel="license"', ''), paper), null);
  assert.equal(extractPublisherSource(html.replace('/by/4.0/', '/by-nc/4.0/'), paper), null);
  assert.throws(() => extractPublisherSource(html, { ...paper, title: 'Another paper' }));
  assert.throws(() => extractPublisherSource(html.replace('https://aclanthology.org/N19-1423.pdf', 'https://other.example/file.pdf'), paper));
});

test('only the exact explicit scholarly-figure grant enables the restricted figure fallback', () => {
  const statement = 'Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.';
  assert.equal(permitsScholarlyFigures(statement.replace('tables and figures', 'tables and\nfigures')), true);
  for (const text of [
    'Personal use of this material is permitted. Permission must be obtained for reuse.',
    statement.replace('grants permission', 'does not grant permission'),
    statement.replace('tables and figures', 'abstract'),
  ]) assert.equal(permitsScholarlyFigures(text), false);
  assert.deepEqual(extractFigure(`<figure class="ltx_figure"><img src="/html/1706.03762/assets/model.png">
    <figcaption>Figure 1: Transformer.</figcaption></figure>`, 'https://ar5iv.labs.arxiv.org/html/1706.03762'), {
    url: 'https://ar5iv.labs.arxiv.org/html/1706.03762/assets/model.png', caption: 'Figure 1: Transformer.',
  });
  assert.equal(extractFigure('<figure class="ltx_figure"><img src="https://ar5iv.labs.arxiv.org/html/1706.03762/model.png"></figure>',
    'https://arxiv.org/html/1706.03762'), null);
});
