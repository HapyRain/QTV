'use client';

import HomePage from '../page';

/**
 * 兼容 /about 路由：直接重定向或展示统一的移动端「我的/关于」中心，
 * 彻底移除旧版桌面端空格/方向键说明页面。
 */
export default function AboutPage() {
  return <HomePage />;
}
