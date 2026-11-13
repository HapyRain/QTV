import { describe, expect, it } from 'vitest';
import { createTapArbiter, DBCLICK_WINDOW_MS, SEEK_STEP_SECONDS, decideGestureAxis } from './touch-gestures';

const T0 = 1_000_000;

describe('createTapArbiter（方案 A 轻点仲裁）', () => {
  it('控制栏可见 → 单击立即 hide，并进入吸收窗口', () => {
    const a = createTapArbiter();
    expect(a.decide({ now: T0, controlsVisible: true, xRatio: 0.5 })).toEqual({ kind: 'hide' });
    // 紧随的第二击被吸收（防止「hide 后立刻又被 show」的状态闪烁）
    expect(a.decide({ now: T0 + 100, controlsVisible: false, xRatio: 0.5 })).toEqual({ kind: 'absorb' });
  });

  it('控制栏隐藏 → 首击返回 reveal 令牌，窗口结束后确认才生效', () => {
    const a = createTapArbiter();
    const d = a.decide({ now: T0, controlsVisible: false, xRatio: 0.5 });
    expect(d.kind).toBe('reveal');
    if (d.kind !== 'reveal') throw new Error('unreachable');
    expect(a.takeReveal(d.token)).toBe(true);
    // 已消费的令牌再次确认为 false（幂等）
    expect(a.takeReveal(d.token)).toBe(false);
  });

  it('首击后窗口内的第二击（左 1/3）→ 快退，且首击的 reveal 作废', () => {
    const a = createTapArbiter();
    const first = a.decide({ now: T0, controlsVisible: false, xRatio: 0.2 });
    if (first.kind !== 'reveal') throw new Error('unreachable');
    const second = a.decide({ now: T0 + 150, controlsVisible: false, xRatio: 0.1 });
    expect(second).toEqual({ kind: 'seek', seconds: -SEEK_STEP_SECONDS });
    expect(a.takeReveal(first.token)).toBe(false);
  });

  it('窗口内第二击（右 1/3）→ 快进', () => {
    const a = createTapArbiter();
    a.decide({ now: T0, controlsVisible: false, xRatio: 0.9 });
    const second = a.decide({ now: T0 + 200, controlsVisible: false, xRatio: 0.9 });
    expect(second).toEqual({ kind: 'seek', seconds: SEEK_STEP_SECONDS });
  });

  it('窗口内第二击（中间）→ 播放/暂停（沿用移动端双击语义）', () => {
    const a = createTapArbiter();
    a.decide({ now: T0, controlsVisible: false, xRatio: 0.5 });
    const second = a.decide({ now: T0 + 100, controlsVisible: false, xRatio: 0.5 });
    expect(second).toEqual({ kind: 'toggle-play' });
  });

  it('超出窗口的第二击 → 视为新的首击（重新挂 reveal）', () => {
    const a = createTapArbiter();
    const first = a.decide({ now: T0, controlsVisible: false, xRatio: 0.5 });
    if (first.kind !== 'reveal') throw new Error('unreachable');
    const late = a.decide({ now: T0 + DBCLICK_WINDOW_MS + 1, controlsVisible: false, xRatio: 0.5 });
    expect(late.kind).toBe('reveal');
    // 旧令牌已被顶掉
    expect(a.takeReveal(first.token)).toBe(false);
    if (late.kind !== 'reveal') throw new Error('unreachable');
    expect(a.takeReveal(late.token)).toBe(true);
  });

  it('seek 之后进入吸收窗口：紧随的第三击不触发任何动作', () => {
    const a = createTapArbiter();
    a.decide({ now: T0, controlsVisible: false, xRatio: 0.1 });
    a.decide({ now: T0 + 100, controlsVisible: false, xRatio: 0.1 });
    expect(a.decide({ now: T0 + 150, controlsVisible: false, xRatio: 0.5 })).toEqual({ kind: 'absorb' });
    // 窗口过去后恢复正常
    expect(a.decide({ now: T0 + 100 + DBCLICK_WINDOW_MS + 1, controlsVisible: false, xRatio: 0.5 }).kind).toBe('reveal');
  });

  it('吸收窗口不阻止对「控制栏可见」的正常判定链之外的后续交互', () => {
    const a = createTapArbiter();
    a.decide({ now: T0, controlsVisible: true, xRatio: 0.5 }); // hide
    // 吸收期过后、控制栏若被别处重新显示 → 单击立即 hide
    const after = a.decide({ now: T0 + DBCLICK_WINDOW_MS + 1, controlsVisible: true, xRatio: 0.5 });
    expect(after).toEqual({ kind: 'hide' });
  });

  it('隐藏态首击的 reveal 令牌会被随后的 hide 作废（防旧定时器弹回控制栏）', () => {
    const a = createTapArbiter();
    const first = a.decide({ now: T0, controlsVisible: false, xRatio: 0.5 });
    if (first.kind !== 'reveal') throw new Error('unreachable');
    // 窗口内控制栏被外部事件（如 video:pause）重新显示，用户点按收起
    expect(a.decide({ now: T0 + 100, controlsVisible: true, xRatio: 0.5 })).toEqual({ kind: 'hide' });
    // 旧 reveal 定时器到点时令牌已作废，不得再把控制栏显示回来
    expect(a.takeReveal(first.token)).toBe(false);
  });
});

describe('decideGestureAxis（横竖手势互斥）', () => {
  it('死区内不认轴', () => {
    expect(decideGestureAxis(5, 8)).toBeNull();
    expect(decideGestureAxis(-8, 5)).toBeNull();
  });

  it('斜向 45° 附近继续等，不误触任何一侧', () => {
    expect(decideGestureAxis(20, 20)).toBeNull();
    expect(decideGestureAxis(18, 22)).toBeNull();
  });

  it('横向明显占优 → seek', () => {
    expect(decideGestureAxis(30, 8)).toBe('seek');
    expect(decideGestureAxis(-40, 12)).toBe('seek');
  });

  it('纵向明显占优 → brightness/volume', () => {
    expect(decideGestureAxis(9, 30)).toBe('vertical');
    expect(decideGestureAxis(-12, -44)).toBe('vertical');
  });

  it('比例阈值可调：自定义 ratio=2 时 1.5 倍仍算斜向', () => {
    expect(decideGestureAxis(30, 20, 12, 2)).toBeNull();
    expect(decideGestureAxis(50, 20, 12, 2)).toBe('seek');
  });
});
