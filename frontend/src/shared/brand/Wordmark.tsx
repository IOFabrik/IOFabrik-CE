import { memo } from 'react';
import { ICON_SIZES } from '../constants';
import iofabrikMark from './iofabrik-mark.svg';
function Wordmark(): JSX.Element {
  return (
    <span
      role="img"
      aria-label="IOFabrik"
      className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap font-sans text-lg leading-5 font-semibold text-theme-primary"
    >
      <img src={iofabrikMark} alt="" width={ICON_SIZES.lg} height={ICON_SIZES.lg} />
      <span aria-hidden="true">IOFabrik</span>
    </span>
  );
}

export default memo(Wordmark);
