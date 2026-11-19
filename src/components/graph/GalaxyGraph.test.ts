import { describe, expect, it } from 'vitest';
import { mixPalettes, type NodePalette } from './GalaxyGraph';

const RED: NodePalette = {
  core: '#ff0000',
  mid: '#000000',
  halo: '255, 0, 0',
};
const GREEN: NodePalette = {
  core: '#00ff00',
  mid: '#ffffff',
  halo: '0, 255, 0',
};

describe('mixPalettes', () => {
  it('在起点和终点返回对应颜色，并限制越界进度', () => {
    expect(mixPalettes(RED, GREEN, 0)).toEqual(RED);
    expect(mixPalettes(RED, GREEN, -1)).toEqual(RED);
    expect(mixPalettes(RED, GREEN, 1)).toEqual(GREEN);
    expect(mixPalettes(RED, GREEN, 2)).toEqual(GREEN);
  });

  it('使用缓动插值，让星体、亮边和光晕同步变色', () => {
    expect(mixPalettes(RED, GREEN, 0.5)).toEqual({
      core: '#20df00',
      mid: '#dfdfdf',
      halo: '32, 223, 0',
    });
  });
});
