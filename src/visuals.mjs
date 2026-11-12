const robotPatterns = [
  ['Fetch', /\bFetch robot\b/i],
  ['Franka Emika Panda', /\b(?:Franka(?: Emika)? Panda|Panda robot)\b/i],
  ['Franka FR3', /\bFranka (?:Research 3|FR3)\b/i],
  ['Unitree G1', /\b(?:Unitree G1|G1 humanoid)\b/i],
  ['UR5e', /\bUR5e(?: robot)?\b/i],
  ['UR5', /\bUR5(?: robot)?\b/i],
];

export function identifyUsedRobot(pages, sourceUrl) {
  for (const page of pages) {
    const text = page.text.split(/\bReferences\b/i)[0];
    for (const sentence of text.match(/[^.!?]+[.!?]?/g) ?? []) {
      if (!/\b(?:we (?:deployed|use|used|utilize|conduct|evaluate|performed)|our (?:robot|platform|hardware|experiments?))\b/i.test(sentence)) continue;
      if (/\b(?:not|without|prior|previous|related|simulated|simulation)\b/i.test(sentence)) continue;
      for (const [name, pattern] of robotPatterns) {
        if (pattern.test(sentence)) return {
          name, evidence: sentence.replace(/\s+/g, ' ').trim(),
          sourceUrl, pageNumber: page.pageNumber,
        };
      }
    }
  }
  return null;
}

const keywordRules = [
  [/\bORB-SLAM2\b/i, 'ORB-SLAM2'],
  [/\bORB-SLAM\b/i, 'ORB-SLAM'],
  [/\bproximal policy optimization\b|\bPPO\b/i, 'PPO'],
  [/\bclipped (?:surrogate )?objective\b|\bclipping\b/i, 'Clipped Objective'],
  [/\bsurrogate objective\b/i, 'Surrogate Objective'],
  [/\bstochastic gradient ascent\b/i, 'Stochastic Gradient Ascent'],
  [/\bresidual (?:learning|network)/i, 'Residual Learning'],
  [/\bskip connection/i, 'Skip Connections'],
  [/\bImageNet\b/i, 'ImageNet'],
  [/\btactile\b/i, 'Tactile Sensing'],
  [/\bcontact[- ]rich\b/i, 'Contact-rich Manipulation'],
  [/\bACT\b|action chunking/i, 'ACT'],
  [/\bdomain randomization\b/i, 'Domain Randomization'],
  [/\bsim[- ]to[- ]real\b/i, 'Sim-to-real'],
  [/\bvisual SLAM\b|simultaneous localization and mapping/i, 'Visual SLAM'],
  [/\bloop clos(?:ure|ing)\b/i, 'Loop Closure'],
  [/\bbundle adjustment\b/i, 'Bundle Adjustment'],
  [/\bon[- ]policy\b/i, 'On-policy RL'],
];

export function visualKeywords(paper) {
  const content = `${paper.title} ${paper.abstract}`;
  const matches = keywordRules.filter(([pattern]) => pattern.test(content)).map(([, label]) => label);
  const words = [paper.robotEvidence?.name, ...matches].filter(Boolean);
  return words.length ? [...new Set(words)].slice(0, 3) : [paper.title.split(/[:：]/)[0].slice(0, 64)];
}
