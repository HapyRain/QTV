/**
 * 播放时长统计与休息提醒（每天累计；每满 45 分钟提示一次）。
 * 只在视频真正播放时累计（暂停/停止不计），按自然日重置。
 */

const STORAGE_KEY = 'ltv_playtime_v1';
/** 提醒间隔（分钟） */
export const REMINDER_INTERVAL_MIN = 45;

interface PlaytimeState {
  date: string;
  seconds: number;
  /** 今天已提醒过几次 */
  notified: number;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function load(): PlaytimeState {
  const today = todayStr();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PlaytimeState | null;
    if (raw && raw.date === today && typeof raw.seconds === 'number') return raw;
  } catch { /* 存储损坏按新的一天处理 */ }
  return { date: today, seconds: 0, notified: 0 };
}

function save(state: PlaytimeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* 隐私模式等存储不可写：本次会话内不累计，不影响播放 */ }
}

/**
 * 累计播放秒数；跨越下一个 45 分钟整数关口时返回应提醒的分钟数（45/90/135…），否则 null。
 */
export function addPlaytime(deltaSeconds: number): number | null {
  if (deltaSeconds <= 0) return null;
  const state = load();
  state.seconds += deltaSeconds;
  const target = (state.notified + 1) * REMINDER_INTERVAL_MIN * 60;
  let reminderMinute: number | null = null;
  if (state.seconds >= target) {
    state.notified += 1;
    reminderMinute = state.notified * REMINDER_INTERVAL_MIN;
  }
  save(state);
  return reminderMinute;
}

/** 今日已播放分钟数（供展示/调试） */
export function playedMinutesToday(): number {
  return Math.floor(load().seconds / 60);
}
