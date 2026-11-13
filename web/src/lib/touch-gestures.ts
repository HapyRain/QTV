/**
 * 播放器触屏轻点仲裁（方案 A，见 MOBILE_APP_PLAN_V2 §8.2）。
 *
 * 背景：ArtPlayer 内置的 video click 处理（单击 → 控制栏 toggle、双击 → 播放/暂停）
 * 与新增的「双击 ±10s seek」以及 issue #937 的「单击即时 toggle」互相冲突。
 * 方案 A 的拍板：控制栏可见时单击立即 hide（零延迟）；控制栏隐藏时单击延迟一个
 * 双击窗口判定——窗口内第二击按左右区域 seek，超时才显示控制栏。
 *
 * 本模块只做纯状态决策（不碰 DOM / 定时器，时间由调用方注入），便于单测；
 * 接线与「阻止浏览器合成 click」在 player-shell 的 touch 处理里完成。
 */

/** 双击判定窗口（与 ArtPlayer DBCLICK_TIME 默认值一致） */
export const DBCLICK_WINDOW_MS = 300;
/** seek 步长（秒） */
export const SEEK_STEP_SECONDS = 10;

export type TapDecision =
  /** 吞掉本次轻点：不改任何状态，也不放行原生 click */
  | { kind: 'absorb' }
  /** 控制栏可见 → 立即收起 */
  | { kind: 'hide' }
  /** 双击两侧 → seek（seconds 为负是快退、为正是快进） */
  | { kind: 'seek'; seconds: number }
  /** 双击中间 → 播放/暂停（沿用 ArtPlayer 移动端双击语义） */
  | { kind: 'toggle-play' }
  /** 隐藏态的首次轻点：调用方在窗口结束后用 takeReveal(token) 确认再显示控制栏 */
  | { kind: 'reveal'; token: number };

export interface TapArbiter {
  readonly windowMs: number;
  decide(input: { now: number; controlsVisible: boolean; xRatio: number }): TapDecision;
  /** 到点后确认 reveal 令牌是否仍有效（期间若发生双击/新轻点则失效） */
  takeReveal(token: number): boolean;
}

export function createTapArbiter(windowMs: number = DBCLICK_WINDOW_MS): TapArbiter {
  /** 等待第二击的首次轻点（时间戳 + 令牌） */
  let pending: { at: number; token: number } | null = null;
  /** 此时间前的轻点全部吞掉：切断「hide 后紧跟的第二击」「seek 后的连击」等状态链 */
  let absorbUntil = 0;
  let seq = 0;

  return {
    windowMs,
    decide({ now, controlsVisible, xRatio }) {
      if (now < absorbUntil) return { kind: 'absorb' };

      if (controlsVisible) {
        // 同时作废未消费的 reveal 令牌：否则「隐藏态首击挂了 reveal → 窗口内控制栏被
        // 外部事件（video:pause 等）重新显示 → 用户再点收起」后，旧定时器到点仍会
        // takeReveal 成功，把刚收起的控制栏又弹回来
        pending = null;
        absorbUntil = now + windowMs;
        return { kind: 'hide' };
      }

      if (pending && now - pending.at <= windowMs) {
        pending = null;
        absorbUntil = now + windowMs;
        if (xRatio < 1 / 3) return { kind: 'seek', seconds: -SEEK_STEP_SECONDS };
        if (xRatio > 2 / 3) return { kind: 'seek', seconds: SEEK_STEP_SECONDS };
        return { kind: 'toggle-play' };
      }

      pending = { at: now, token: ++seq };
      return { kind: 'reveal', token: pending.token };
    },
    takeReveal(token) {
      if (pending && pending.token === token) {
        pending = null;
        return true;
      }
      return false;
    },
  };
}

/**
 * 手势轴向判定：手指超过阈值后，按 |dx|/|dy| 的比值锁定为单向手势。
 *
 * 背景：全屏里亮度/音量（纵向）与跳进度（横向）都挂在视频面上，斜着拖一下
 * 两边都会触发——竖拖带点横移会跳进度、横拖带点竖移会改亮度。
 * 这里用比值 + 死区做互斥：先拉开到 1.3 倍才认，斜向（45° 附近）继续等，
 * 一旦认了就由调用方锁定该轴，另一轴不再响应。
 */
export function decideGestureAxis(
  dx: number,
  dy: number,
  threshold = 12,
  ratio = 1.3,
): 'seek' | 'vertical' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  if (ax > ay * ratio) return 'seek';
  if (ay > ax * ratio) return 'vertical';
  return null;
}
