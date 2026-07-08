module.exports = {
  types: [
    { type: 'feat',     section: 'Features' },
    { type: 'fix',      section: 'Bug Fixes' },
    { type: 'perf',     section: 'Performance Improvements' },
    { type: 'revert',   section: 'Reverts' },
    { type: 'docs',     section: 'Documentation Changes' },
    { type: 'style',    section: 'Styles' },
    { type: 'refactor', section: 'Code Refactoring' },
    { type: 'ci',       section: 'CI/CD Changes' },
    { type: 'build',    section: 'Build System Changes' },
    { type: 'chore',    section: 'Miscellaneous Chores' },
    { type: 'test',     section: 'Tests' },
  ],
  commitUrlFormat: '{{host}}/{{owner}}/{{repo}}/commit/{{hash}}',
  compareUrlFormat: '{{host}}/{{owner}}/{{repo}}/compare/{{previousTag}}...{{currentTag}}',
  issueUrlFormat: '{{host}}/{{owner}}/{{repo}}/issues/{{id}}',
  releaseCommitMessageFormat: 'chore(release): v{{currentTag}} [skip ci]',
  scripts: {
    postbump: 'node scripts/postversion.mjs',
  },
}
