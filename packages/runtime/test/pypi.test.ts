import { describe, expect, it } from 'vitest';
import { pickSdist } from '../src/index.ts';

const sdist = {
  packagetype: 'sdist',
  filename: 'demo-1.2.3.tar.gz',
  url: 'https://files.pythonhosted.org/packages/xx/demo-1.2.3.tar.gz',
  yanked: false,
};
const wheel = {
  packagetype: 'bdist_wheel',
  filename: 'demo-1.2.3-py3-none-any.whl',
  url: 'https://files.pythonhosted.org/packages/xx/demo-1.2.3-py3-none-any.whl',
  yanked: false,
};

describe('PyPI sdist 选择', () => {
  it('优先 sdist，忽略 wheel', () => {
    const picked = pickSdist({ info: { version: '1.2.3' }, urls: [wheel, sdist] });
    expect(picked.filename).toBe('demo-1.2.3.tar.gz');
    expect(picked.url).toContain('demo-1.2.3.tar.gz');
  });

  it('被 yank 的版本不用', () => {
    expect(() =>
      pickSdist({ info: { version: '1.2.3' }, urls: [{ ...sdist, yanked: true }, wheel] }),
    ).toThrow(/只发了 wheel|没有可用的/);
  });

  it('只有 wheel 时明确拒绝（不装二进制）', () => {
    expect(() => pickSdist({ urls: [wheel] })).toThrow(/只发了 wheel/);
  });

  it('没有 .tar.gz 的 sdist 也拒绝', () => {
    expect(() =>
      pickSdist({ urls: [{ ...sdist, filename: 'demo-1.2.3.zip', url: 'https://x/demo.zip' }] }),
    ).toThrow(/没有可用的/);
  });
});
