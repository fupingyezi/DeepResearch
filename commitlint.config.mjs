/**
 * commit message 规范：Conventional Commits。
 * 契约：type 取值受控（feat/fix/... 及项目常用 chore/ci/build），
 * subject 允许中文、放宽长度上限以适配中文描述；不强制 subject 大小写。
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    // 中文 subject 常触发 case/长度限制，放宽以避免误伤
    'subject-case': [0],
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [0],
  },
};
