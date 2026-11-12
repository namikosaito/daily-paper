import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyUsedRobot, visualKeywords } from '../src/visuals.mjs';

test('robot reference photos require evidence of the authors using the exact platform', () => {
  const sourceUrl = 'https://arxiv.org/pdf/1703.06907';
  const text = 'We deployed the pipeline on a Fetch robot, and evaluated grasping.';
  assert.deepEqual(identifyUsedRobot([{ pageNumber: 6, text }], sourceUrl), {
    name: 'Fetch', evidence: text, sourceUrl, pageNumber: 6,
  });
  for (const text of [
    'Related work uses a Fetch robot.', 'A Franka Panda robot is a popular platform.',
    'References We used a Fetch robot.', 'We evaluate an image model without robots.',
    'We use results from previous work with a Fetch robot.', 'We use a Fetch robot in simulation.',
  ]) assert.equal(identifyUsedRobot([{ pageNumber: 1, text }], sourceUrl), null);
  assert.equal(identifyUsedRobot([{ pageNumber: 2, text: 'We use a Unitree G1 for locomotion.' }], sourceUrl).name, 'Unitree G1');
  assert.equal(identifyUsedRobot([{ pageNumber: 2, text: 'We use a UR5e robot.' }], sourceUrl).name, 'UR5e');
});

test('keyword cards use paper-specific concepts without fabricating a robot platform', () => {
  const orb = { title: 'ORB-SLAM2', abstract: 'Visual SLAM with loop closure and bundle adjustment.', topics: ['Robotics'] };
  assert.deepEqual(visualKeywords(orb), ['ORB-SLAM2', 'Visual SLAM', 'Loop Closure']);
  const ppo = { title: 'Proximal Policy Optimization', abstract: 'A clipped surrogate objective for on-policy learning.', topics: ['AI'] };
  assert.deepEqual(visualKeywords(ppo), ['PPO', 'Clipped Objective', 'Surrogate Objective']);
  const generic = { title: 'A Novel Visual Representation', abstract: '', topics: [] };
  assert.deepEqual(visualKeywords(generic), ['A Novel Visual Representation']);
  assert.ok(!visualKeywords(orb).some(word => /Franka|G1|Fetch/.test(word)));
  assert.deepEqual(visualKeywords({
    title: 'Deep Residual Learning for Image Recognition',
    abstract: 'Residual learning on ImageNet.', topics: ['Residual RL'],
  }), ['Residual Learning', 'ImageNet']);
});
