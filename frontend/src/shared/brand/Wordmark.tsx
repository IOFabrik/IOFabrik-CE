import { memo } from 'react';
function Wordmark(): JSX.Element {
  return (
    <span
      role="img"
      aria-label="IOFabrik"
      className="inline-flex h-8 shrink-0 items-center whitespace-nowrap font-sans text-lg leading-5 font-semibold text-theme-primary"
    >
      <span aria-hidden="true">IOFabrik</span>
    </span>
  );
}

export default memo(Wordmark);
