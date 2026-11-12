import React from 'react';
import { t } from '../../i18n/index.js';
import { settleDrawerMotionPhase } from './useDrawerTransition.js';
import DrawerFallbackSurface from './DrawerFallbackSurface.jsx';
import { getTopmostModal } from './drawerFocus.js';

export default class DrawerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
    this.returnFocus = null;
    this.focusFrame = null;
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error(`[DrawerErrorBoundary] ${this.props.title || 'Drawer'} crashed:`, error, errorInfo);
    settleDrawerMotionPhase();
  }
  componentDidMount() {
    if (this.props.isOpen) this.returnFocus = globalThis.document?.activeElement;
  }
  getSnapshotBeforeUpdate(previousProps) {
    return !previousProps.isOpen && this.props.isOpen ? globalThis.document?.activeElement ?? null : null;
  }
  componentDidUpdate(previousProps, _previousState, opener) {
    if (!previousProps.isOpen && this.props.isOpen) {
      if (this.focusFrame !== null) globalThis.cancelAnimationFrame?.(this.focusFrame);
      this.focusFrame = null;
      this.returnFocus = opener;
    }
    if (previousProps.isOpen && !this.props.isOpen) {
      settleDrawerMotionPhase();
      const target = this.returnFocus;
      this.returnFocus = null;
      this.focusFrame = globalThis.requestAnimationFrame?.(() => {
        this.focusFrame = null;
        const topModal = getTopmostModal(globalThis.document);
        if (target?.isConnected && !target.closest?.('[inert]') && (!topModal || topModal.contains(target))) target.focus({ preventScroll: true });
      }) ?? null;
    }
  }
  componentWillUnmount() {
    if (this.focusFrame !== null) globalThis.cancelAnimationFrame?.(this.focusFrame);
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
      return <DrawerFallbackSurface title={this.props.title || t('组件加载未完成')} isFullScreen={this.props.isFullScreen} panelClassName={this.props.panelClassName} error onClose={this.handleClose} onReload={this.handleReload} />;
    }
    // Healthy drawers own their exit animation and release the motion phase on close.
    return this.props.children;
  }
}
