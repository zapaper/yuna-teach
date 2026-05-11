"use client";

import React from "react";

// Catches any render-time exception thrown inside <DocumentScanner>
// so a single bad frame / worker crash / camera permission edge case
// doesn't blow up the whole dashboard with the generic Next.js
// "Application error: a client-side exception has occurred." page.
//
// React error boundaries MUST be class components — there is no hook
// equivalent for componentDidCatch / getDerivedStateFromError yet.
// We keep the class minimal: state holds the captured error, the
// render branches on it, and onReset re-mounts the inner tree by
// bumping a key passed from the parent (or, if no key is passed,
// just clears local state and re-renders — the caller is expected
// to also unmount the scanner via the action button so the parent's
// scannerTarget state is cleared).
//
// Logging: we console.error the captured error + componentStack so
// the actual stack lands in the iOS Web Inspector / browser console.
// The "Application error" generic page eats stacks; this surfaces
// them.

type Props = {
  children: React.ReactNode;
  onReset: () => void;
};

type State = { error: Error | null; info: React.ErrorInfo | null };

export default class ScannerErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Stack + componentStack go straight to the console so the
    // iOS Safari Web Inspector / Chrome DevTools shows them.
    console.error("[scanner] crash:", error);
    console.error("[scanner] component stack:", info.componentStack);
    this.setState({ info });
  }

  reset = () => {
    this.setState({ error: null, info: null });
    this.props.onReset();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Surface a focused, full-screen fallback so the user is never
    // stranded on the generic Next.js error page. Buttons let them
    // bail back to the dashboard. We deliberately stay on a black
    // background so it visually feels like the scanner is "what
    // crashed" rather than the whole app.
    return (
      <div className="fixed inset-0 z-[200] bg-black text-white flex flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="material-symbols-outlined text-5xl text-white/70">photo_camera_off</span>
        <p className="text-base font-bold">Scanner crashed</p>
        <p className="text-sm text-white/70 max-w-sm">
          Something went wrong while processing the page. Your captured pages have been lost — please reopen the scanner and try again.
        </p>
        <p className="text-xs text-white/40 max-w-sm break-all">
          {error.message || String(error)}
        </p>
        <button
          onClick={this.reset}
          className="mt-4 px-5 py-2.5 rounded-full bg-white text-black text-sm font-bold"
        >
          Close scanner
        </button>
      </div>
    );
  }
}
