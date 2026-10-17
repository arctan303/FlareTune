import React from 'react';
import { t } from '../../i18n/index.js';
import { settleDrawerMotionPhase } from './useDrawerTransition.js';

export default class DrawerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error(`[DrawerErrorBoundary] ${this.props.title || 'Drawer'} crashed:`, error, errorInfo);
    settleDrawerMotionPhase();
  }
  componentDidUpdate(previousProps) {
    if (previousProps.isOpen && !this.props.isOpen) settleDrawerMotionPhase();
  }
  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };
  handleClose = () => {
    this.setState({ hasError: false, error: null });
    if (typeof this.props.onClose === 'function') {
      this.props.onClose();
    }
    settleDrawerMotionPhase();
  };
  render() {
    if (this.state.hasError) {
      if (this.props.isOpen === false) return null;
      const isModal = Boolean(this.props.isModal);
      const containerClass = isModal
        ? 'fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-6 backdrop-blur-md'
        : 'fixed inset-y-0 right-0 z-[120] flex w-full max-w-sm flex-col justify-center border-l border-white/10 bg-[var(--surface-raised)]/95 p-6 shadow-2xl backdrop-blur-2xl';
      return (
        <aside className={containerClass} role="alert">
          <div className="text-center">
            <h3 className="mb-2 text-base font-semibold text-[color:var(--ink)]">{this.props.title || t("组件加载未完成")}</h3>
            <p className="mb-5 text-xs leading-relaxed text-[color:var(--muted)]">
              {this.state.error?.message?.includes('Failed to fetch') || this.state.error?.message?.includes('dynamically imported')
                ? t("网络连接波动或资源繁忙，未能成功加载组件。")
                : (this.state.error?.message || t("组件暂时不可用"))}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="primary-button min-h-9 px-4 py-1.5 text-xs font-semibold"
              >{t("刷新页面")}</button>
              <button
                type="button"
                onClick={this.handleClose}
                className="theme-drawer__close-btn inline-flex min-h-9 items-center justify-center rounded-xl border border-white/10 px-4 py-1.5 text-xs font-semibold text-[color:var(--muted)] hover:text-[color:var(--ink)]"
              >{t("关闭")}</button>
            </div>
          </div>
        </aside>
      );
    }
    // Healthy drawers own their exit animation and release the motion phase on close.
    return this.props.children;
  }
}
