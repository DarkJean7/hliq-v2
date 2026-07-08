// Insolvent logo — Terminal Prompt direction
// Drop into any React app. Requires IBM Plex Mono loaded globally:
//   <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
//
// Usage:
//   <InsolventLogo />                           // default 32px
//   <InsolventLogo size={96} />                 // hero
//   <InsolventLogo size={18} animate={false} /> // static, inline

import React from 'react';

const STYLES = `
.insolvent-logo {
  font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--insolvent-fg, #e5e9f0);
  display: inline-flex;
  align-items: center;
  gap: 0.08em;
  user-select: none;
}
.insolvent-logo .prompt {
  color: var(--insolvent-accent, #84e96b);
  font-weight: 400;
  margin-right: 0.12em;
}
.insolvent-logo .cursor {
  display: inline-block;
  width: 0.5em;
  height: 0.96em;
  background: var(--insolvent-accent, #84e96b);
  margin-left: 0.12em;
}
.insolvent-logo .cursor.animate {
  animation: insolvent-blink 1s steps(1) infinite;
}
@keyframes insolvent-blink { 50% { opacity: 0; } }
`;

let injected = false;
function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  const tag = document.createElement('style');
  tag.setAttribute('data-insolvent-logo', '');
  tag.textContent = STYLES;
  document.head.appendChild(tag);
  injected = true;
}

export function InsolventLogo({ size = 32, animate = true, className = '', style }) {
  React.useEffect(injectStyles, []);
  return (
    <span
      className={`insolvent-logo ${className}`}
      style={{ fontSize: size, ...style }}
      role="img"
      aria-label="insolvent"
    >
      <span className="prompt" aria-hidden="true">{'>'}</span>
      <span>insolvent</span>
      <span className={`cursor ${animate ? 'animate' : ''}`} aria-hidden="true" />
    </span>
  );
}

export default InsolventLogo;
