'use strict'

const assert = require('node:assert/strict')
const { ProfileSummary } = require('./profile-client')

const summary = ProfileSummary.from({
  nodes: [
    { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    { id: 2, callFrame: { functionName: 'decode', url: 'file:///private/work/dist/result.js', lineNumber: 6 } },
    { id: 3, callFrame: { functionName: '', url: '', lineNumber: 0 } },
  ],
  samples: [1, 2, 2, 3],
})

assert.deepEqual(summary, {
  totalSamples: 4,
  activeSamples: 3,
  frames: [
    { name: 'decode', source: 'dist/result.js', line: 7, samples: 2 },
    { name: '(anonymous)', source: '(generated)', line: 1, samples: 1 },
  ],
})
assert.throws(() => ProfileSummary.from({ nodes: [], samples: [99] }), /existing node/)
console.log('PASS: CPU sample accounting and source-path removal')
