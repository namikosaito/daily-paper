import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlAffiliations, extractPdfAffiliations } from '../src/affiliations.mjs';

test('HTML affiliations are extracted from explicit roles, deduplicated and stripped of contact details', () => {
  const html = `<span class="ltx_role_affiliation">Affiliation: Princeton University</span>
    <span class="ltx_role_affiliation">Affiliation: Princeton University</span>
    <span class="ltx_role_affiliation">††affiliation: \\affilnum* Joint First Author
    \\affilnum1Columbia University, US \\affilnum2Toyota Research Institute, US.</span>
    <p>Unrelated Institute in the paper body</p>`;
  assert.deepEqual(extractHtmlAffiliations(html), ['Princeton University', 'Columbia University, US', 'Toyota Research Institute, US']);
});

test('PDF affiliation parsing uses explicit institution-like lines, not email domains or model mentions', () => {
  const result = extractPdfAffiliations([
    '1 Carnegie Mellon University', '2 Microsoft Research', '3 Department of Computer Science, Stanford University',
    'Our model was trained using OpenAI models.', 'contact@example.edu', 'arXiv:2611.10000',
  ]);
  assert.deepEqual(result, ['Carnegie Mellon University', 'Microsoft Research', 'Department of Computer Science, Stanford University']);
  assert.deepEqual(extractPdfAffiliations(['Nothing about an institution.']), []);
});
